import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename, extname } from 'node:path';
import { sameFile } from '../server/request-checks.mjs';

const source = fs.readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('function underRoot('), source.indexOf('/* OATSWEB_FILEGUARD_END */'));
const readContainedFile = new Function('realpathSync', 'resolve', 'sep', 'fsConstants', 'sameFile',
  `${block}; return readContainedFile;`)(fs.realpathSync, resolve, sep, fs.constants, sameFile);
const LIMIT = 2 * 1024 * 1024;

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'oats-contained-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root'), other = join(base, 'other');
  fs.mkdirSync(root); fs.mkdirSync(other);
  const inside = join(root, 'note.md'), outside = join(other, 'note.md');
  fs.writeFileSync(inside, 'inside'); fs.writeFileSync(outside, 'outside');
  return { base, root, other, inside, outside };
}

// Hooks wrap the actual filesystem boundary; every descriptor and byte is real.
function reader(roots, hooks = {}, options = {}) {
  const descriptors = [], reads = [];
  const io = {
    openSync(...args) { const fd = fs.openSync(...args); descriptors.push(fd); hooks.open?.(...args); return fd; },
    fstatSync(fd) { const st = fs.fstatSync(fd); hooks.fstat?.(st); return st; },
    realpathSync(path) { const real = fs.realpathSync(path); hooks.realpath?.(path, real); return real; },
    statSync(path) { hooks.stat?.(path); return fs.statSync(path); },
    readSync(...args) { hooks.read?.(); const n = fs.readSync(...args); reads.push(n); return n; },
    closeSync(fd) { fs.closeSync(fd); },
  };
  return { reads, read(path) {
    try {
      return readContainedFile(path, roots, { maxBytes: LIMIT, ...options, io });
    } finally {
      for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    }
  } };
}

function refused(r, path, code) {
  const result = r.read(path);
  assert.equal(result.code, code);
  assert.equal(result.buf, undefined);
  assert.equal(r.reads.length, 0, 'refuse before reading content');
  return result;
}

test('contained file: ordinary files and stable links preserve content and descriptor metadata', t => {
  const f = fixture(t), r = reader([f.root]);
  const result = r.read(f.inside);
  assert.equal(result.buf.toString(), 'inside');
  assert.equal(result.real, f.inside);
  assert.equal(r.read(f.root + '/missing/../note.md').buf.toString(), 'inside');
  assert.equal(result.st.ino, fs.statSync(f.inside).ino);
  assert.equal(result.st.mtimeMs, fs.statSync(f.inside).mtimeMs);
  const link = join(f.root, 'link.md'); fs.symlinkSync(f.inside, link);
  assert.equal(r.read(link).buf.toString(), 'inside');
  assert.equal(r.read(link).real, f.inside);
  const hard = join(f.root, 'hard.md'); fs.linkSync(f.inside, hard);
  assert.equal(r.read(hard).buf.toString(), 'inside');
});

test('contained file: absolute paths, missing files, containment and prefixes', t => {
  const f = fixture(t), r = reader([f.root]);
  refused(r, 'relative.md', 400);
  refused(r, join(f.root, 'missing'), 404);
  refused(r, f.outside, 403);
  refused(r, join(f.root, '..', 'other', 'note.md'), 403);
  const sibling = f.root + '-sibling'; fs.mkdirSync(sibling);
  fs.writeFileSync(join(sibling, 'note.md'), 'outside');
  refused(r, join(sibling, 'note.md'), 403);
  const link = join(f.root, 'link.md'); fs.symlinkSync(f.outside, link);
  refused(r, link, 403);
});

test('contained file: a permission refusal does not disclose paths outside the roots', t => {
  const f = fixture(t);
  fs.chmodSync(f.outside, 0o000);
  const io = {
    ...fs,
    openSync(...args) {
      // Privileged runners can open mode 000, so supply the error at the syscall boundary there.
      if (process.getuid() === 0) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return fs.openSync(...args);
    },
    readSync() { assert.fail('a denied open must not read content'); },
  };
  assert.deepEqual(readContainedFile(f.outside, [f.root], { maxBytes: LIMIT, io }),
    { error: 'path outside allowed roots', code: 403 });
});

test('contained file: directories, FIFOs, sockets and devices are refused without blocking', async t => {
  const f = fixture(t);
  refused(reader([f.root]), f.root, 400);
  const fifo = join(f.root, 'fifo'); execFileSync('mkfifo', [fifo]);
  refused(reader([f.root]), fifo, 400);
  // A short socket pathname also works with macOS's sockaddr_un length limit.
  const socket = join(f.base, 's'), server = createServer();
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(socket, ok); });
  t.after(() => new Promise(ok => server.close(ok)));
  refused(reader([f.base]), socket, 400);
  refused(reader([f.root]), socket, 403);
  const link = join(f.root, 'socket-link'); fs.symlinkSync(socket, link);
  refused(reader([f.base]), link, 400);
  refused(reader(['/dev']), '/dev/null', 400);
});

for (const phase of ['open', 'realpath']) for (const initial of ['inside', 'outside']) {
  test(`contained file: parent identity stays checked (${phase}, ${initial})`, t => {
    const f = fixture(t), parent = join(f.root, 'parent'), saved = join(f.root, 'saved');
    fs.mkdirSync(parent); fs.writeFileSync(join(parent, 'note.md'), 'inside');
    if (initial === 'outside') { fs.renameSync(parent, saved); fs.symlinkSync(f.other, parent); }
    let changed = false;
    const swap = () => {
      if (changed) return;
      changed = true;
      if (initial === 'outside') { fs.unlinkSync(parent); fs.renameSync(saved, parent); }
      else { fs.renameSync(parent, saved); fs.symlinkSync(f.other, parent); }
    };
    refused(reader([f.root], { [phase]: swap }), join(parent, 'note.md'), 403);
    assert.equal(changed, true);
  });
}

for (const phase of ['open', 'realpath']) test(`contained file: leaf identity stays checked (${phase})`, t => {
  const f = fixture(t);
  const swap = () => { fs.unlinkSync(f.inside); fs.symlinkSync(f.outside, f.inside); };
  refused(reader([f.root], { [phase]: swap }), f.inside, 403);
});

test('contained file: a stable in-root link also verifies the opened target identity', t => {
  const f = fixture(t), link = join(f.root, 'link.md'); fs.symlinkSync(f.inside, link);
  refused(reader([f.root], { open() { fs.unlinkSync(f.inside); fs.writeFileSync(f.inside, 'replacement'); } }), link, 403);
});

test('contained file: admitted roots are not resolved again', t => {
  const f = fixture(t);
  fs.renameSync(f.root, f.root + '-saved'); fs.symlinkSync(f.other, f.root);
  refused(reader([f.root]), join(f.root, 'note.md'), 403);
});

test('contained file: credential identities include hard links and links', t => {
  const f = fixture(t), identity = fs.statSync(f.inside);
  const hard = join(f.root, 'hard'), link = join(f.root, 'link');
  fs.linkSync(f.inside, hard); fs.symlinkSync(f.inside, link);
  for (const path of [f.inside, hard, link]) {
    const result = refused(reader([f.root], {}, { tokenFile: identity }), path, 403);
    assert.equal(result.error, 'forbidden');
  }
});

test('contained file: exact limit, growth, truncation and replacement keep reads bounded', t => {
  const f = fixture(t);
  fs.writeFileSync(f.inside, Buffer.alloc(LIMIT, 97));
  assert.equal(reader([f.root]).read(f.inside).buf.length, LIMIT);
  const grow = reader([f.root], { fstat() { fs.appendFileSync(f.inside, Buffer.alloc(100, 98)); } });
  assert.equal(grow.read(f.inside).code, 413);
  assert.equal(grow.reads.reduce((a, b) => a + b, 0), LIMIT + 1);
  const tooLarge = refused(reader([f.root]), f.inside, 413);
  assert.equal(tooLarge.error, `file too large (${LIMIT + 100} bytes)`);
  const shrink = reader([f.root], { fstat() { fs.truncateSync(f.inside, 3); } });
  // Start at the limit so that the metadata allows a bounded content read.
  fs.truncateSync(f.inside, LIMIT);
  assert.equal(shrink.read(f.inside).buf.length, 3);
  fs.writeFileSync(f.inside, 'original');
  let changed = false;
  const replace = reader([f.root], { read() {
    if (changed) return; changed = true;
    fs.renameSync(f.inside, f.inside + '.old'); fs.writeFileSync(f.inside, 'replacement');
  } });
  assert.equal(replace.read(f.inside).buf.toString(), 'original');
});

for (const phase of ['fstat', 'stat', 'read']) test(`contained file: ${phase} I/O failures close descriptors`, t => {
  const f = fixture(t);
  const error = Object.assign(new Error('I/O error'), { code: 'EIO' });
  const r = reader([f.root], { [phase]() { throw error; } });
  assert.throws(() => r.read(f.inside), e => e === error);
});

test('contained file: disappearance during validation closes the descriptor and returns 404', t => {
  const f = fixture(t);
  const r = reader([f.root], { fstat() { fs.unlinkSync(f.inside); } });
  refused(r, f.inside, 404);
});

test('contained file: admitted paths preserve unexpected open errors for the HTTP handler', t => {
  const f = fixture(t);
  for (const code of ['EACCES', 'EMFILE', 'EIO']) {
    const error = Object.assign(new Error(code), { code });
    const io = { ...fs, openSync() { throw error; } };
    assert.throws(() => readContainedFile(f.inside, [f.root], { maxBytes: LIMIT, io }),
      e => e === error, code);
  }
});

test('/api/file: descriptor content determines size; response fields and refusals stay stable', t => {
  const f = fixture(t), roots = [f.root];
  const fileDataSource = source.slice(source.indexOf('function fileData('), source.indexOf('// ---- HTTP ----'));
  const read = (path, admitted, options) => readContainedFile(path, admitted, { ...options, io: {
    ...fs, fstatSync(fd) { const st = fs.fstatSync(fd); fs.truncateSync(f.inside, 2); return st; },
  } });
  const make = new Function('readContainedFile', 'fileRoots', 'FILE_MAX_BYTES', 'TOKEN_FILE', 'MARKDOWN_EXT', 'basename', 'extname',
    `${fileDataSource}; return fileData;`);
  const file = make(read, () => roots, LIMIT, null, new Set(['.md']), basename, extname);
  const st = fs.statSync(f.inside), result = file(f.inside);
  assert.deepEqual(result.body, { path: f.inside, name: 'note.md', size: 2, mtime: st.mtime.toISOString(), markdown: true, content: 'in' });
  fs.writeFileSync(f.inside, Buffer.from([0, 65]));
  const normal = make((p, r, o) => readContainedFile(p, r, { ...o, io: fs }), () => roots, LIMIT, null, new Set(['.md']), basename, extname);
  assert.deepEqual(normal(f.inside), { error: 'binary file', code: 415 });
});


test('brain skills: shared reader contains and bounds frontmatter, including credential identities', t => {
  const f = fixture(t), skill = join(f.root, 'skill'); fs.mkdirSync(skill);
  const path = join(skill, 'SKILL.md');
  fs.writeFileSync(path, '---\nname: named\ndescription: displayed\n---\n');
  const entrySource = source.slice(source.indexOf('function skillEntry('), source.indexOf('function mdTree('));
  const frontmatter = source.slice(source.indexOf('function skillFrontmatter('), source.indexOf('/** The canonical path'));
  const make = (read, token = null) => new Function('join', 'basename', 'existsSync', 'readContainedFile', 'FILE_MAX_BYTES', 'TOKEN_FILE',
    `${frontmatter}; ${entrySource}; return skillEntry;`)(join, basename, fs.existsSync, read, LIMIT, token);
  const normalRead = (p, roots, options) => readContainedFile(p, roots, { ...options, io: fs });
  const entry = make(normalRead);
  assert.deepEqual(entry(skill, [f.root]), { name: 'named', description: 'displayed', path });
  const unreadable = make((p, roots, options) => readContainedFile(p, roots, { ...options, io: {
    ...fs, openSync() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
  } }));
  assert.deepEqual(unreadable(skill, [f.root]), { name: 'skill', description: '', path });
  assert.deepEqual(make(normalRead, fs.statSync(path))(skill, [f.root]), { name: 'skill', description: '', path });
  fs.writeFileSync(path, Buffer.alloc(LIMIT + 1, 65));
  assert.deepEqual(entry(skill, [f.root]), { name: 'skill', description: '', path });
  fs.unlinkSync(path); fs.symlinkSync(f.outside, path);
  assert.equal(entry(skill, [f.root]), null);
  fs.unlinkSync(path); fs.writeFileSync(path, 'inside');
  const changedRead = (p, roots, options) => readContainedFile(p, roots, { ...options, io: {
    ...fs, realpathSync(p) { const real = fs.realpathSync(p); fs.unlinkSync(path); fs.symlinkSync(f.outside, path); return real; },
  } });
  assert.equal(make(changedRead)(skill, [f.root]), null);
});
