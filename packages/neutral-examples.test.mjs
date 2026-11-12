// Examples and fixtures under packages/ use invented owners, never a real person's home directory:
// an owner's home path belongs to that deployment, not to what OATS ships or tests. This test fails
// when an example's `/Users/<name>` or `/home/<name>` (or Claude's encoded `-Users-<name>-`) names
// someone not on the list of invented owners below.
//
// It covers home paths only. Other deployment specifics (a real machine's name, a private
// repository) have no generic shape to check for; review catches them.
//
// It sits at the root of packages/ because it reads all of them. CI runs it on every pull request
// through the root runner's `packages/**/*.test.mjs` glob (scripts/run-tests.mjs); it is not in
// the npm package (package.json `files`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url), PACKAGES = dirname(SELF);

// The invented owners an example's home directory may name. A new one must be obviously invented
// (`alex`, `user`), never someone's login. The last few are folders a fixture puts right under a
// bare /home or a temporary root's home/, not owners.
const INVENTED_HOMES = new Set([
  'a', 'abcd-1234', 'agent', 'alex', 'ana', 'birth', 'builder', 'context', 'dev', 'dev-fail', 'dev-held',
  'dev-pending', 'dev-wait', 'empty', 'fixture', 'h1', 'host', 'me', 'o', 'op', 'operator', 'ops', 'options',
  'person', 'server', 'someone', 'u', 'user', 'work', 'workdir', 'x', 'zo', 'zoe',
  '.config', 'agents', 'library', 'oats',
]);

// Not read: installed dependencies, build output, and binary assets (any other file holding a NUL
// byte is skipped too).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.webp', '.woff', '.woff2', '.ttf', '.otf', '.gz', '.tgz', '.zip', '.pdf']);
// Not cleaned yet; the Desktop's cleanup removes this entry.
const PENDING = ['desktop/'];

function* textFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* textFiles(path); continue; }
    // This file's own cases name an owner on purpose.
    if (!entry.isFile() || path === SELF || BINARY.has(extname(entry.name).toLowerCase())) continue;
    const rel = relative(PACKAGES, path).split('\\').join('/');
    if (PENDING.some(prefix => rel.startsWith(prefix))) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes('\0')) yield { rel, text };
  }
}

// `/Users/<name>` or `/home/<name>`: the segment up to the next separator (an interpolated `${…}`
// is the code's, not an example, and does not match). `-Users-<name>-`: Claude's encoded form.
const HOME = /\/(?:Users|home)\/([A-Za-z0-9._-]+)|-Users-([A-Za-z0-9._]+)-/g;

/** `where:line` for each home directory in `text` that names an owner not on the list. */
function ownerHomes(text, where = '') {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const [, slashed, encoded] of line.matchAll(HOME)) {
      const name = (slashed ?? encoded).replace(/\.+$/, ''); // a sentence's full stop is not the name's
      if (!INVENTED_HOMES.has(name.toLowerCase())) out.push(`${where}:${i + 1}: /…/${name}`);
    }
  });
  return out;
}

test('an owner home directory fails unless its owner is an invented one', () => {
  assert.deepEqual(ownerHomes('cwd: "/Users/alex/work/acme", home: "/home/user/x", at `/home/${who}/y`'), []);
  assert.deepEqual(ownerHomes('cwd: "/Users/robin/work"'), [':1: /…/robin']);
  assert.deepEqual(ownerHomes('a\nroot: /home/robin.'), [':2: /…/robin']);
  assert.deepEqual(ownerHomes('dir: "-Users-robin-private"'), [':1: /…/robin']);
  assert.deepEqual(ownerHomes('dir: "-Users-alex-private"'), []);
});

test('no example or fixture under packages/ names a real owner\'s home directory', () => {
  const found = [];
  for (const { rel, text } of textFiles(PACKAGES)) found.push(...ownerHomes(text, `packages/${rel}`));
  assert.deepEqual(found, [], 'use an invented owner (alex, user) that keeps the example\'s point, or add an invented one to INVENTED_HOMES');
});
