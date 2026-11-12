import assert from "node:assert/strict";
import { checkRelease } from "./check-team-image-release.mjs";
import { checkImageLockDiff } from "./team-image-lock-diff.mjs";
import { checkMetadata, checkResolved, resolvedPath } from "./team-image-release-context.mjs";

const KERNEL = "@awebai/oats", KERNEL_PATH = `node_modules/${KERNEL}`;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PR_KERNEL_SPEC = "file:../oats-build-inputs/oats-pr-kernel.tgz";

function requireBaseline(manifest, lock) {
  try { checkRelease("tag", `v${manifest.dependencies?.[KERNEL]}`, manifest, lock); }
  catch (cause) { throw new Error("packed PR image requires a compatible committed image baseline; migrate it instead of widening the guard", { cause }); }
}

// The baseline is a released image closure; the candidate kernel is the exact
// local pack, not a registry version or a fallback to the committed kernel.
export function checkPrImageLock({ sourceManifest, sourceLock, manifest, lock, kernel, metadata }) {
  requireBaseline(sourceManifest, sourceLock);
  assert.equal(kernel.name, KERNEL, "local pack must be the kernel");
  assert.equal(kernel.manifest.name, KERNEL);
  assert.equal(kernel.manifest.version, kernel.version);
  assert.match(kernel.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(manifest.dependencies[KERNEL], PR_KERNEL_SPEC, "fixed local kernel spec required");
  checkResolved(KERNEL_PATH, lock, { ...kernel.manifest, dist: { tarball: PR_KERNEL_SPEC, integrity: kernel.integrity } });
  const allowed = new Set([KERNEL_PATH]);
  for (const [name, pin] of Object.entries(kernel.manifest.dependencies ?? {})) {
    assert.match(pin, EXACT, `kernel dependency must be an exact stable version: ${name}`);
    const dependency = checkMetadata(name, pin, metadata[name]);
    const target = resolvedPath(lock, name);
    assert.ok(target, `missing exact kernel dependency: ${name}`);
    checkResolved(target, lock, dependency);
    allowed.add(target);
    const previous = resolvedPath(sourceLock, name);
    if (previous && !lock.packages[previous]) allowed.add(previous);
  }
  checkImageLockDiff({ sourceManifest, sourceLock, manifest, lock }, allowed);
}
