// Import the launch-preference capture (capture-launch.mjs): the REAL kernel (provenance.json kernelTree,
// with #290) on its own test helper's deployment: every launch `from` layer, a drift, a missing harness.
// The committed fixtures are that capture, from `oats version` 0.29.4 at main 69d76a91: their kernel texts
// are that kernel's wording and are not refreshed to follow a later one (capture-launch.mjs says why).
// NEVER runs a CLI itself. <base>/<oats> placeholders become absolute fixture paths.
// Usage: node import-capture.mjs CAPTURE_OUT_DIR
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const [source] = process.argv.slice(2);
if (typeof source !== 'string' || !source.startsWith('/')) throw new Error('One explicit absolute capture directory required');
const target = fileURLToPath(new URL('.', import.meta.url));
const documents = ['version', 'souls', 'souls-unavailable', 'inspect-soul-dev', 'inspect-soul-reviewer', 'preview-dev', 'preview-dev-flag',
  'preview-dev-unavailable', 'inspect-home', 'inspect-home-drift', 'readiness-home-drift', 'status',
  // #292's review: the reverse drift (host, at null) and default-team-changed (DefaultTeam recorded/current).
  'inspect-home-reverse-drift', 'readiness-home-reverse-drift', 'inspect-home-default-team-changed', 'readiness-home-default-team-changed'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const captured = JSON.parse(readFileSync(join(source, 'provenance.json'), 'utf8'));
const provenance = { source: `${captured.capturedBy}; ${captured.fixture}; ${captured.script}`, kernelTree: captured.kernelTree,
  redactions: ['<base> (deployment scratch) → /fixture/base', '<oats> (kernel tree) → /fixture/oats'], files: {} };
for (const name of documents) {
  const original = readFileSync(join(source, `${name}.json`));
  const run = captured.documents.find(d => d.name === name);
  if (!run) throw new Error(`${name}: not in the capture provenance`);
  const text = original.toString('utf8').replaceAll('<base>', '/fixture/base').replaceAll('<oats>', '/fixture/oats');
  const bytes = Buffer.from(JSON.stringify(JSON.parse(text), null, 2) + '\n');
  provenance.files[name] = { argv: run.argv, exit: run.exit, commit: run.commit, sourceSha256: sha(original), fixtureSha256: sha(bytes) };
  writeFileSync(join(target, `${name}.json`), bytes);
}
writeFileSync(join(target, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(`imported ${documents.length} documents`);
