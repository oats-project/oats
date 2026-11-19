import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkInstalledVersion } from "./check-team-image-release.mjs";

// Only this image's marked block is owned by CI; all other release prose stays.
export function updateReceipt(notes, evidence) {
  const { imageReference, sourceTag, sourceCommit, kernelVersion, lockDigest, kernelIntegrity } = evidence;
  assert.match(imageReference, /^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/);
  assert.match(sourceTag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  checkInstalledVersion(JSON.stringify({ version: kernelVersion }), sourceTag.slice(1));
  assert.match(lockDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(kernelIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const start = `<!-- team-image:${imageReference} -->`;
  const end = `<!-- /team-image:${imageReference} -->`;
  const block = `${start}
### Team agent image — build and startup checks

- Image: \`${imageReference}\` (\`linux/amd64\`). Deploy using this digest reference.
- Source: \`${sourceTag}\` at \`${sourceCommit}\`.
- Installed kernel: \`@awebai/oats ${kernelVersion}\`; runtime version equals the release tag.
- Build lock: \`${lockDigest}\`; kernel npm integrity: \`${kernelIntegrity}\`.
- PASS: image build; non-root user; read-only root; sshd startup; image/configuration digest binding.
- NOT RUN: supervisor startup; admitted-seat spawn; wake delivery; package sync; inference; mail/chat; viewer; governance; platform containment and network/egress-bypass checks.

This receipt covers build and startup checks. It does not establish agent readiness, wake delivery, or platform containment.
${end}`;
  const from = notes.indexOf(start), to = notes.indexOf(end);
  if (from === -1 && to === -1) return `${notes}${notes.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
  assert.ok(from >= 0 && to > from && notes.indexOf(start, from + start.length) === -1 && notes.indexOf(end, to + end.length) === -1,
    "ambiguous image receipt markers; repair the release notes before retrying");
  return notes.slice(0, from) + block + notes.slice(to + end.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [notesFile, imageReference] = process.argv.slice(2);
  const inputs = JSON.parse(readFileSync(process.env.BUILD_INPUTS, "utf8"));
  assert.equal(inputs.sourceTag, process.env.GITHUB_REF_NAME, "build input source tag mismatch");
  assert.equal(inputs.sourceCommit, process.env.GITHUB_SHA, "build input source commit mismatch");
  assert.equal(inputs.kernelVersion, process.env.INSTALLED_OATS_VERSION, "build and installed kernel versions must equal");
  writeFileSync(notesFile, updateReceipt(readFileSync(notesFile, "utf8"), { ...inputs, imageReference }));
}
