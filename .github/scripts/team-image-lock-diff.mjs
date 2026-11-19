import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const KERNEL = "@awebai/oats";

// Both registry and local-pack adapters validate their own kernel identity.
// Neither may use that allowance to alter another CLI or unrelated lock entry.
export function checkImageLockDiff({ sourceManifest, sourceLock, manifest, lock }, allowed) {
  const expectedManifest = structuredClone(sourceManifest);
  expectedManifest.dependencies[KERNEL] = manifest.dependencies[KERNEL];
  assert.deepEqual(manifest, expectedManifest, "only the manifest's OATS dependency may change");
  for (const name of Object.keys(sourceManifest.dependencies)) {
    if (name === KERNEL) continue;
    const path = `node_modules/${name}`;
    assert.ok(isDeepStrictEqual(lock.packages[path], sourceLock.packages[path]), `unrelated protected CLI lock entry changed: ${name}`);
  }
  const expectedRoot = structuredClone(sourceLock.packages[""]);
  expectedRoot.dependencies[KERNEL] = manifest.dependencies[KERNEL];
  assert.deepEqual(lock.packages[""], expectedRoot, "unrelated lock root change");
  assert.deepEqual({ ...lock, packages: undefined }, { ...sourceLock, packages: undefined }, "unrelated lock metadata change");
  for (const path of new Set([...Object.keys(sourceLock.packages), ...Object.keys(lock.packages)])) {
    if (path === "" || allowed.has(path)) continue;
    assert.ok(isDeepStrictEqual(sourceLock.packages[path], lock.packages[path]), `unrelated lock entry changed: ${path}; migrate the committed image baseline instead of widening this allowance`);
  }
}
