// The one way tests start the bundled backend (server/oats-web.mjs) and talk to it: a fresh
// credential handed over fd 3, as main hands it, a private socket directory, and requests over
// that socket with `node:http` (`socketPath`), never a TCP port.
//
//   const s = await startBackend({ dirs: [deployment], env });
//   const panel = await (await s.request('/api/panel')).json();     // authorized
//   const refused = await s.raw({ path: '/api/cli' });               // no credential: 401
//   await s.stop();
//
// `request(path, init)` answers a WHATWG Response (status, ok, headers, text(), json()), so code
// written against fetch keeps its shape. `raw(...)` sends exactly the headers it is given.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

export const SERVER = new URL('../../server/oats-web.mjs', import.meta.url).pathname;
export const READY_LINE = 'oats-desktop-server ready';

/** A credential as main makes one: 32 random bytes, base64url (43 characters). */
export const backendSecret = () => randomBytes(32).toString('base64url');

/** A private (0700) directory for a socket, under the system temp directory (a short path). */
export function privateSocketDir(prefix = 'oats-t-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return { dir, socketPath: join(dir, 's'), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One HTTP request over `socketPath` with exactly these headers (plus node's own framing headers).
 * `target` is sent verbatim as the request target. Resolves a Response; rejects on a transport failure. */
export function backendRequest(socketPath, { path: target = '/', method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: target, method, headers, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: h }));
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The headers every authorized test request carries: a loopback Host and the credential. */
export const authorizedHeaders = (secret, headers = {}) => ({ host: 'localhost', ...headers, authorization: `Bearer ${secret}` });

/** A fetch-shaped authorized requester over `socketPath`: `(path, { method, headers, body, signal })`. */
export const authorizedRequest = (socketPath, secret) => (path, init = {}) => backendRequest(socketPath, {
  path, method: init.method ?? 'GET', headers: authorizedHeaders(secret, init.headers ?? {}), body: init.body, signal: init.signal,
});

/** Wait for the ready line on `child`'s stdout; rejects if the child exits first or after `timeout`. */
export function waitReady(child, { timeout = 30_000, output = () => '' } = {}) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => done(new Error(`backend never printed its ready line in ${timeout} ms: ${output()}`)), timeout);
    const onData = (d) => { seen += d; if (seen.split('\n').includes(READY_LINE)) done(); };
    const onExit = (code, signal) => done(new Error(`backend exited before it was ready (code ${code}, signal ${signal}): ${output()}`));
    function done(error) {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * Start the server with a fresh credential on fd 3 and a private socket. `args` follow
 * `--socket … --token-fd 3` and the `--dir`s. `stdin: 'pipe'` keeps a lifeline pipe open.
 * Resolves once the ready line is out.
 */
export async function startBackend({ dirs = [], args = [], env = process.env, cwd, detached = false, stdin = 'ignore',
  spawn = nodeSpawn, socket = privateSocketDir(), secret = backendSecret(), tokenFile = null, timeout } = {}) {
  // `tokenFile`: the operator's way (--token-file, a 0600 file written here), instead of fd 3.
  if (tokenFile) writeFileSync(tokenFile, `${secret}\n`, { mode: 0o600 });
  const credential = tokenFile ? ['--token-file', tokenFile] : ['--token-fd', '3'];
  const argv = [SERVER, 'start', '--socket', socket.socketPath, ...credential, ...dirs.flatMap((d) => ['--dir', d]), ...args];
  const child = spawn(process.execPath, argv, { stdio: [stdin, 'pipe', 'pipe', tokenFile ? 'ignore' : 'pipe'], env, cwd, detached });
  if (!tokenFile) {
    child.stdio[3].on('error', () => { /* the server read it and closed it, or never started */ });
    child.stdio[3].end(secret);
  }
  return served(child, { socketPath: socket.socketPath, dir: socket.dir, remove: socket.remove }, secret, { detached, timeout });
}

/**
 * Start the server exactly as main does: launchServerChild (a private socket directory under
 * `socketBase` and a fresh credential on fd 3) over serverSpawnSpec. `o` is serverSpawnSpec's input
 * without `socketPath` (defaults: no deployment, Node as execPath, the real server).
 */
export async function startBackendThroughSpec(o = {}, { spawn = nodeSpawn, socketBase = tmpdir(), timeout } = {}) {
  const { launchServerChild, serverSpawnSpec } = await import('../../server-host.mjs');
  let spec;
  const launched = launchServerChild({ spawn, socketBase, spec: (socketPath) => (spec = serverSpawnSpec({
    execPath: process.execPath, bin: SERVER, dirs: [], pathSource: 'inherited', pathError: null, home: tmpdir(), env: process.env,
    remoteIdentityFile: join(socketBase, `oats-t-remote-${process.pid}-${Date.now()}.json`), ...o, socketPath })) });
  const s = await served(launched.child, { socketPath: launched.socketPath, dir: dirname(launched.socketPath), remove: launched.remove }, launched.secret, { timeout });
  return { ...s, spec };
}

async function served(child, socket, secret, { detached = false, timeout } = {}) {
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin?.on?.('error', () => { /* gone */ });
  try { await waitReady(child, { timeout, output: () => `${stdout}\n${stderr}` }); }
  catch (e) { try { child.kill('SIGKILL'); } catch { /* gone */ } socket.remove(); throw e; }
  const request = authorizedRequest(socket.socketPath, secret);
  return {
    child, secret, socketPath: socket.socketPath, dir: socket.dir,
    request,
    raw: (opts) => backendRequest(socket.socketPath, opts),
    get: async (path) => (await request(path)).json(),
    post: async (path, body, headers = {}) => (await request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })).json(),
    stdout: () => stdout,
    stderr: () => stderr,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        try { if (detached) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* gone */ }
        await exited;
      }
      socket.remove();
    },
  };
}
