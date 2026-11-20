// server/request-checks.mjs through its exports, with the file system the one boundary replaced:
// the refusals no real file on this host can reach (the real server and real files are driven in
// backend-startup-checks.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSecretFile, StartupRefusal } from '../server/request-checks.mjs';

const SECRET = 'A'.repeat(43);
/** An fs whose one open file is `stat`, holding a valid secret; records whether it was closed. */
function fakeFs(stat) {
  const fs = { closed: false, read: 0 };
  Object.assign(fs, {
    openSync: () => 7,
    fstatSync: () => stat,
    readSync: (fd, buf) => { if (fs.read) return 0; fs.read = buf.write(`${SECRET}\n`); return fs.read; },
    closeSync: () => { fs.closed = true; },
  });
  return fs;
}
const regular = { isFile: () => true, uid: 1000, mode: 0o100600, dev: 1, ino: 2 };

test('readSecretFile serves a regular 0600 file of this uid holding a valid secret', () => {
  const fs = fakeFs(regular);
  assert.deepEqual(readSecretFile('/t', { uid: 1000, fs }), { secret: SECRET, identity: { dev: 1, ino: 2 } });
  assert.equal(fs.closed, true);
});

test('readSecretFile refuses anything but a regular file, whatever it holds, and closes it', () => {
  for (const mode of [0o010600, 0o020600, 0o140600, 0o060600]) { // FIFO, character device, socket, block device
    const fs = fakeFs({ ...regular, mode, isFile: () => false });
    assert.throws(() => readSecretFile('/t', { uid: 1000, fs }), (e) => e instanceof StartupRefusal && /regular file/.test(e.message), mode.toString(8));
    assert.equal(fs.read, 0, 'nothing is read from it');
    assert.equal(fs.closed, true, 'it is closed');
  }
});
