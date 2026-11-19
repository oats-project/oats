// OATS Desktop icon set — every derived icon is regenerated from the ONE
// committed source artwork (assets/brand/oats-logo.png) by this script:
//
//   npm run icons            (from packages/desktop) — rewrite assets/brand/generated/
//   npm run icons -- --check — verify the checked-in set derives from the source
//
// Zero-dependency: node:zlib/node:crypto only. PNG decoding/encoding and the
// area-average resampler are implemented here so the derivation is exact and
// reviewable; the check compares DECODED PIXELS (deflate bytes may differ
// across zlib builds, pixels may not). Aspect and transparency are preserved:
// the source must be square, and resampling is done in premultiplied alpha.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = 'assets/brand/oats-logo.png';
export const GENERATED = 'assets/brand/generated';
export const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];
// ICNS PNG-payload types (macOS 10.7+). Retina types reuse the doubled size.
export const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(...parts) {
  let c = 0xffffffff;
  for (const part of parts) for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG to RGBA bytes. */
export function decodePNG(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let offset = 8, header = null; const data = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error('truncated PNG chunk');
    if (buffer.readUInt32BE(offset + 8 + length) !== crc32(buffer.subarray(offset + 4, offset + 8), body)) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || ![2, 6].includes(header.color) || header.interlace !== 0) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)');
  const { width, height } = header, channels = header.color === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has the wrong size');
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0, up = previous[i], upLeft = i >= channels ? previous[i - channels] : 0;
      let add;
      if (filter === 0) add = 0; else if (filter === 1) add = left; else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1; else if (filter === 4) add = paeth(left, up, upLeft);
      else throw new Error(`bad PNG filter ${filter}`);
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, i = x * channels;
      pixels[o] = line[i]; pixels[o + 1] = line[i + 1]; pixels[o + 2] = line[i + 2]; pixels[o + 3] = channels === 4 ? line[i + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode RGBA bytes as an 8-bit RGBA PNG (adaptive per-row filter). */
export function encodePNG({ width, height, pixels }) {
  const stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  let previous = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    let best = 0, bestScore = Infinity, bestLine = null;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? line[i - 4] : 0, up = previous[i], upLeft = i >= 4 ? previous[i - 4] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const value = (line[i] - predictor) & 0xff; candidate[i] = value; score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { bestScore = score; best = filter; bestLine = Buffer.from(candidate); }
    }
    raw[y * (stride + 1)] = best; bestLine.copy(raw, y * (stride + 1) + 1);
    previous = line;
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(head.subarray(4), body), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Exact area-average downscale of a square RGBA image, in premultiplied alpha. */
export function resize(image, size) {
  const { width, height, pixels } = image;
  if (width !== height) throw new Error('source artwork must be square');
  if (!Number.isInteger(size) || size < 1 || size > width) throw new Error(`cannot derive ${size}px from ${width}px`);
  const taps = weights(width, size);
  // Horizontal pass: width → size, premultiplying as we read.
  const mid = new Float64Array(size * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sx, w] of taps[x]) {
        const o = (y * width + sx) * 4, alpha = pixels[o + 3] / 255 * w;
        r += pixels[o] * alpha; g += pixels[o + 1] * alpha; b += pixels[o + 2] * alpha; a += alpha;
      }
      const m = (y * size + x) * 4; mid[m] = r; mid[m + 1] = g; mid[m + 2] = b; mid[m + 3] = a;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sy, w] of taps[y]) {
        const m = (sy * size + x) * 4; r += mid[m] * w; g += mid[m + 1] * w; b += mid[m + 2] * w; a += mid[m + 3] * w;
      }
      const o = (y * size + x) * 4, alpha = Math.round(Math.min(1, a) * 255);
      out[o + 3] = alpha;
      if (a > 0) { out[o] = clamp(r / a); out[o + 1] = clamp(g / a); out[o + 2] = clamp(b / a); }
    }
  }
  return { width: size, height: size, pixels: out };
}
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
function weights(from, to) {
  const scale = from / to, taps = [];
  for (let i = 0; i < to; i++) {
    const start = i * scale, end = (i + 1) * scale, row = [];
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
      const cover = Math.min(end, s + 1) - Math.max(start, s);
      if (cover > 0) row.push([s, cover / scale]);
    }
    taps.push(row);
  }
  return taps;
}

/** Apple icon container of PNG payloads. */
export function encodeICNS(entries) {
  const parts = entries.map(([type, png]) => {
    const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8); head.write('icns', 0, 'latin1'); head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}
/** Split an ICNS container into [type, payload] entries. */
export function decodeICNS(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'icns' || buffer.readUInt32BE(4) !== buffer.length) throw new Error('not an ICNS container');
  const entries = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) throw new Error('bad ICNS entry');
    entries.push([buffer.toString('latin1', offset, offset + 4), buffer.subarray(offset + 8, offset + length)]);
    offset += length;
  }
  return entries;
}

export const pixelDigest = image => sha256(Buffer.concat([Buffer.from(`${image.width}x${image.height}\n`), image.pixels]));

/** Derive the full icon set (file → bytes) and its manifest from the source bytes. */
export function deriveIconSet(sourceBytes) {
  const source = decodePNG(sourceBytes);
  // No sidebar mark since the Desktop UI rework (slice 1 took it from the foot, slice 2 stopped generating it).
  const sizes = [...new Set([...LINUX_SIZES, ...ICNS_TYPES.map(([, s]) => s)])].sort((a, b) => a - b);
  const images = new Map(sizes.map(size => [size, resize(source, size)]));
  const pngs = new Map([...images].map(([size, image]) => [size, encodePNG(image)]));
  const files = new Map();
  for (const size of LINUX_SIZES) files.set(`linux/${size}x${size}.png`, pngs.get(size));
  files.set('oats.icns', encodeICNS(ICNS_TYPES.map(([type, size]) => [type, pngs.get(size)])));
  const manifest = {
    regenerate: 'cd packages/desktop && npm run icons',
    source: { path: SOURCE, sha256: sha256(sourceBytes), width: source.width, height: source.height },
    pixels: Object.fromEntries([...images].map(([size, image]) => [String(size), pixelDigest(image)])),
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
  };
  return { files, manifest, images };
}

function main(argv) {
  const sourceBytes = readFileSync(join(HERE, SOURCE));
  const { files, manifest } = deriveIconSet(sourceBytes);
  const out = join(HERE, GENERATED);
  if (argv.includes('--check')) {
    const recorded = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const problems = [];
    if (recorded.source.sha256 !== manifest.source.sha256) problems.push('manifest source hash is not the committed source');
    if (JSON.stringify(recorded.pixels) !== JSON.stringify(manifest.pixels)) problems.push('manifest pixel digests do not derive from the source');
    for (const name of Object.keys(manifest.files)) {
      const path = join(out, name);
      if (!existsSync(path)) { problems.push(`${name} is missing`); continue; }
      if (sha256(readFileSync(path)) !== recorded.files[name]) problems.push(`${name} does not match the manifest`);
    }
    if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; } else console.log('icon set derives from the committed source');
    return;
  }
  rmSync(out, { recursive: true, force: true });
  for (const [name, bytes] of files) { mkdirSync(dirname(join(out, name)), { recursive: true }); writeFileSync(join(out, name), bytes); }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${files.size} icon files from ${SOURCE} (${manifest.source.sha256.slice(0, 12)}…)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
