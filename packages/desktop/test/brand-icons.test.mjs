// The derived icon set is a pure function of the ONE committed source
// artwork. Pixels (not deflate bytes) are compared, so a different zlib build
// cannot fail this; a hand-edited or stale icon, or a swapped source, does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from '../electron-builder.config.cjs';
import { decodeICNS, decodePNG, deriveIconSet, encodePNG, GENERATED, ICNS_TYPES, LINUX_SIZES, pixelDigest, resize, SOURCE } from '../build-icons.mjs';

const PKG = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(PKG, path));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// The human-supplied artwork (disposition e5698c8b / faba8a55).
const SOURCE_SHA256 = 'b1d21d9a43b7915ba19d9d0b1850af8130087607dbb499e4bcb71237de0de69e';
const derived = deriveIconSet(read(SOURCE));
const manifest = JSON.parse(read(`${GENERATED}/manifest.json`));

test('the committed source is the supplied artwork: square RGBA with a transparent ground', () => {
  assert.equal(sha256(read(SOURCE)), SOURCE_SHA256);
  const source = decodePNG(read(SOURCE));
  assert.equal(source.width, source.height); assert.equal(source.width, 1254);
  assert.equal(source.pixels[3], 0, 'corner is transparent');
});

test('the checked-in manifest and files are exactly what the source derives', () => {
  assert.deepEqual(manifest.source, derived.manifest.source);
  assert.deepEqual(manifest.pixels, derived.manifest.pixels, 'every size derives from the source');
  assert.equal(manifest.regenerate, 'cd packages/desktop && npm run icons');
  const onDisk = [];
  const walk = dir => { for (const e of readdirSync(join(PKG, GENERATED, dir), { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name)) : onDisk.push(join(dir, e.name)); };
  walk('');
  assert.deepEqual(onDisk.sort(), [...Object.keys(derived.manifest.files), 'manifest.json'].sort(), 'no stray or missing generated file');
  for (const name of Object.keys(derived.manifest.files)) assert.equal(sha256(read(`${GENERATED}/${name}`)), manifest.files[name], `${name} matches its manifest hash`);
});

test('every checked-in PNG decodes to the pixels its size derives from the source', () => {
  for (const size of LINUX_SIZES) {
    const image = decodePNG(read(`${GENERATED}/linux/${size}x${size}.png`));
    assert.equal(image.width, size); assert.equal(image.height, size);
    assert.equal(pixelDigest(image), derived.manifest.pixels[String(size)], `${size}px`);
    assert.equal(image.pixels[3], 0, `${size}px keeps the transparent ground`);
  }
});

test('the ICNS container carries each Apple type at its size, derived from the source', () => {
  const entries = decodeICNS(read(`${GENERATED}/oats.icns`));
  assert.deepEqual(entries.map(([type]) => type), ICNS_TYPES.map(([type]) => type));
  for (const [[type, payload], [, size]] of entries.map((e, i) => [e, ICNS_TYPES[i]])) {
    const image = decodePNG(Buffer.from(payload));
    assert.equal(image.width, size, type);
    assert.equal(pixelDigest(image), derived.manifest.pixels[String(size)], type);
  }
});

test('the codec and resampler are exact: round trip, identity size, premultiplied edges', () => {
  const tiny = { width: 2, height: 2, pixels: Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 10, 20, 30, 40]) };
  assert.deepEqual(decodePNG(encodePNG(tiny)), tiny);
  // Opaque red, TRANSPARENT blue, opaque green, 40-alpha grey: the average is
  // premultiplied, so the transparent blue contributes nothing.
  assert.deepEqual([...resize(tiny, 1).pixels], [119, 120, 2, 138]);
  const source = decodePNG(read(SOURCE));
  const same = resize(source, source.width).pixels;
  let visibleDiffers = 0, alphaDiffers = 0;
  for (let i = 0; i < same.length; i += 4) {
    if (same[i + 3] !== source.pixels[i + 3]) alphaDiffers++;
    else if (same[i + 3] > 0 && (same[i] !== source.pixels[i] || same[i + 1] !== source.pixels[i + 1] || same[i + 2] !== source.pixels[i + 2])) visibleDiffers++;
  }
  assert.deepEqual({ alphaDiffers, visibleDiffers }, { alphaDiffers: 0, visibleDiffers: 0 }, 'identity size keeps every visible pixel exactly');
  assert.throws(() => resize({ width: 2, height: 3, pixels: Buffer.alloc(24) }, 1), /square/);
  assert.throws(() => decodePNG(Buffer.from('not a png')), /not a PNG/);
});

test('electron-builder wires the derived icons per platform; no brand image ships as a file', () => {
  assert.equal(builder.mac.icon, `${GENERATED}/oats.icns`);
  assert.equal(builder.linux.icon, `${GENERATED}/linux`);
  assert.ok(!builder.files.some(f => f.startsWith(`${GENERATED}/`)), 'no generated image ships as a file (the sidebar mark went in slice 2)');
  assert.ok(!existsSync(join(PKG, GENERATED, 'sidebar-48.png')), 'nor is it generated');
  assert.ok(!builder.files.some(f => /oats-logo\.png|assets\/brand\/\*|assets\/\*\*/.test(f)), 'the source artwork is not packaged');
  assert.ok(builder.files.includes('!build-icons.mjs'));
  for (const path of [builder.mac.icon, builder.linux.icon]) assert.ok(existsSync(join(PKG, path)), path);
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts.icons, 'node build-icons.mjs', 'regenerate from source is one command');
});

// The sidebar (the Desktop UI rework): the brand mark left the foot in slice 1, so the renderer draws no mark in the
// sidebar, and slice 2 stopped generating and packaging sidebar-48.png (above).
test('the renderer shows no sidebar mark; nothing references a download path', () => {
  const html = read('renderer/index.html').toString('utf8');
  assert.doesNotMatch(html, /ws-brand-image|ws-brand-mark/, 'the old head mark is gone');
  assert.doesNotMatch(read('renderer/shell.css').toString('utf8'), /\.ws-brand-(image|mark)\b|\.sidebar-brand\b/, 'no style is left for either mark');
  assert.equal([...html.matchAll(/sidebar-\d+\.png|sidebar-brand/g)].length, 0, 'no sidebar mark in the markup');
  for (const file of ['renderer/index.html', 'electron-builder.config.cjs', 'build-icons.mjs', 'package.json', `${GENERATED}/manifest.json`]) {
    assert.doesNotMatch(read(file).toString('utf8'), /Downloads|\/Users\/|~\//, file);
  }
});
