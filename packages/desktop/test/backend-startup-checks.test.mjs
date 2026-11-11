// The server's startup refusals (a credential it can trust, a socket directory private to this
// user, no TCP listener), and the token file never served. The real server process, its exit code,
// its stderr and the file system after it: never its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { SERVER, backendSecret, backendRequest, privateSocketDir, startBackend } from './helpers/backend-server.mjs';
import { startLoadPathServer } from './helpers/load-path-server.mjs';
import { listeningTcpPorts, NO_CLI_ENV } from '../scripts/smoke-probes.mjs';

const HERMETIC = { ...process.env, ...NO_CLI_ENV };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oats-t-start-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** Run the server with `args` (and `fd3` written to its fd 3 when given); resolves once it exits or `ms` passes. */
async function run(args, { fd3, ms = 10_000, preload } = {}) {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), SERVER, 'start', ...args],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: HERMETIC });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdio[3].on('error', () => {});
  if (fd3 !== undefined) child.stdio[3].end(fd3); else child.stdio[3].end();
  const started = Date.now();
  const timer = setTimeout(() => child.kill('SIGKILL'), ms);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, signal, stdout, stderr, elapsed: Date.now() - started };
}
function refused(r, socketPath, flag, secret) {
  assert.notEqual(r.code, 0, `exit non-zero (${flag}): ${r.stderr}`);
  assert.equal(r.signal, null, `exited by itself, not killed (${flag})`);
  assert.equal(existsSync(socketPath), false, `no socket created (${flag})`);
  for (const f of [].concat(flag)) assert.ok(r.stderr.includes(f), `stderr names ${f}: ${r.stderr}`);
  if (secret) assert.equal(r.stderr.includes(secret), false, 'stderr carries no secret');
}
function tokenFile(dir, secret, { mode = 0o600, name = 'token' } = {}) {
  const file = join(dir, name);
  writeFileSync(file, `${secret}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

test('A3: no credential flag, or both, is refused', async (t) => {
  const { socketPath, remove } = privateSocketDir(); t.after(remove);
  const secret = backendSecret();
  refused(await run(['--socket', socketPath]), socketPath, ['--token-fd', '--token-file'], secret);
  const file = tokenFile(scratch(t), secret);
  refused(await run(['--socket', socketPath, '--token-fd', '3', '--token-file', file], { fd3: secret }), socketPath, ['--token-fd', '--token-file'], secret);
});

test('A3: a credential of 42 or 44 characters on fd 3 is refused; an empty or partial write too', async (t) => {
  const { socketPath, remove } = privateSocketDir(); t.after(remove);
  const secret = backendSecret();
  for (const given of [secret.slice(0, 42), `${secret}A`, '', secret.slice(0, 20)]) {
    refused(await run(['--socket', socketPath, '--token-fd', '3'], { fd3: given }), socketPath, '--token-fd', secret);
  }
});

test('A3: a token file that is group/other-readable, a symlink, a FIFO or another uid\'s is refused; 0600 serves', async (t) => {
  const dir = scratch(t);
  const { socketPath, remove } = privateSocketDir(); t.after(remove);
  const secret = backendSecret();
  refused(await run(['--socket', socketPath, '--token-file', tokenFile(dir, secret, { mode: 0o644, name: 'open' })]), socketPath, '--token-file', secret);
  const target = tokenFile(dir, secret, { name: 'target' });
  symlinkSync(target, join(dir, 'link'));
  refused(await run(['--socket', socketPath, '--token-file', join(dir, 'link')]), socketPath, '--token-file', secret);
  execFileSync('mkfifo', [join(dir, 'fifo')]); chmodSync(join(dir, 'fifo'), 0o600);
  const fifo = await run(['--socket', socketPath, '--token-file', join(dir, 'fifo')], { ms: 5000 });
  refused(fifo, socketPath, '--token-file', secret);
  assert.ok(fifo.elapsed < 2000, `a FIFO is refused at once, not waited on (${fifo.elapsed} ms)`);
  mkdirSync(join(dir, 'a-dir'), { mode: 0o700 });
  refused(await run(['--socket', socketPath, '--token-file', join(dir, 'a-dir')]), socketPath, '--token-file', secret);
  if (process.getuid?.() === 0) {
    const theirs = tokenFile(dir, secret, { name: 'theirs' });
    chownSync(theirs, 65534, 65534);
    refused(await run(['--socket', socketPath, '--token-file', theirs]), socketPath, '--token-file', secret);
  } else t.diagnostic('another uid\'s token file not tried: making one needs root, and this runner is not');
  // A token file at 0600: the server serves with that secret, and only with it.
  const s = await startBackend({ env: HERMETIC, tokenFile: join(dir, 'good'), secret });
  t.after(() => s.stop());
  assert.equal((await s.request('/api/version')).status, 200);
  assert.equal((await s.raw({ path: '/api/version', headers: { host: 'localhost', authorization: `Bearer ${backendSecret()}` } })).status, 401);
});

test('A3: a socket under a 0755 directory, a symlinked directory or a missing one is refused', async (t) => {
  const dir = scratch(t);
  const secret = backendSecret();
  const open = join(dir, 'open'); mkdirSync(open); chmodSync(open, 0o755);
  refused(await run(['--socket', join(open, 's'), '--token-fd', '3'], { fd3: secret }), join(open, 's'), '--socket', secret);
  const real = join(dir, 'real'); mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(dir, 'linked'));
  refused(await run(['--socket', join(dir, 'linked', 's'), '--token-fd', '3'], { fd3: secret }), join(real, 's'), '--socket', secret);
  refused(await run(['--socket', join(dir, 'absent', 's'), '--token-fd', '3'], { fd3: secret }), join(dir, 'absent', 's'), '--socket', secret);
});

test('A15(a): the server listens only on its socket; --port is refused', async (t) => {
  const dir = scratch(t);
  const { socketPath, remove } = privateSocketDir(); t.after(remove);
  const secret = backendSecret();
  refused(await run(['--port', '4820', '--socket', socketPath, '--token-fd', '3'], { fd3: secret }), socketPath, '--port', secret);
  // Every listener the process opens reports its address: a string (a socket path), never a TCP address.
  const preload = join(dir, 'addresses.mjs');
  writeFileSync(preload, `import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.stderr.write('LISTENING ' + JSON.stringify(this.address()) + '\\n'));
  return listen.apply(this, args);
};
`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, SERVER, 'start', '--socket', socketPath, '--token-fd', '3'],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: HERMETIC });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdio[3].end(secret);
  for (let n = 0; !stdout.includes('oats-desktop-server ready'); n++) {
    if (n > 400) throw new Error(`never ready: ${stderr}`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
  const addresses = stderr.split('\n').filter((l) => l.startsWith('LISTENING ')).map((l) => JSON.parse(l.slice(10)));
  assert.deepEqual(addresses, [socketPath], 'one listener, on the socket path');
  if (process.platform === 'linux') assert.deepEqual(listeningTcpPorts(child.pid), [], 'no TCP listener (/proc)');
  assert.equal((await backendRequest(socketPath, { path: '/api/version', headers: { host: 'localhost', authorization: `Bearer ${secret}` } })).status, 200);
});

test('A11 (backend): the --token-file is never served by /api/file, by its path, a symlink or a hard link', async (t) => {
  // The token file sits inside a served deployment's agents root, where /api/file would otherwise serve it.
  const s = await startLoadPathServer({ tokenFile: (deployment) => join(deployment, 'agents', 'token') });
  t.after(() => s.stop());
  await s.until(async () => (await s.panel()).deployment?.status === 'observed');
  const agents = join(s.deployment, 'agents');
  writeFileSync(join(agents, 'note.md'), '# a note\n');
  const file = async (path) => { const r = await s.request(`/api/file?path=${encodeURIComponent(path)}`); return { status: r.status, text: await r.text() }; };
  assert.equal((await file(join(agents, 'note.md'))).status, 200, 'the root serves an ordinary file');
  symlinkSync(join(agents, 'token'), join(agents, 'token-link'));
  linkSync(join(agents, 'token'), join(agents, 'token-hard'));
  for (const name of ['token', 'token-link', 'token-hard']) {
    const r = await file(join(agents, name));
    assert.equal(r.status, 403, name);
    assert.equal(r.text.includes(s.secret), false, `${name}: no content`);
  }
});
