import * as fs from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join, sep, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
export { fs, join, resolve, dirname };
export const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJSON = path => JSON.parse(fs.readFileSync(path, 'utf8'));
export const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
// okf 4.0.1 #2: a URL's userinfo is a credential (https://user:token@host).
// Strip it from anything shown to agents or users; an SSH user alone
// (ssh://git@host) is not a secret and stays.
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@'"]+)@/gi;
export const redactUrls = text => String(text).replace(USERINFO, (m, scheme, info) => /^ssh:/i.test(scheme) && !info.includes(':') ? m : scheme);
export const displayRepo = repository => typeof repository === 'string' ? redactUrls(repository) : repository;
/** Whether a repository locator embeds a credential (any userinfo except a bare SSH user). */
export const embedsCredential = repository => { USERINFO.lastIndex = 0; return typeof repository === 'string' && redactUrls(repository) !== repository; };
export const overlaps = (a, b) => within(a, b) || within(b, a);
export function safePath(path) {
  path = resolve(path);
  let part = path;
  while (true) {
    try { if (fs.lstatSync(part).isSymbolicLink()) fail('E_PATH', `symlink not allowed: ${part}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (dirname(part) === part) break;
    part = dirname(part);
  }
  return path;
}
export function relPath(p, dot = false) {
  if (typeof p !== 'string' || (!dot && p === '.') || !p || p.includes('\\') || p.includes('\0') || isAbsolute(p) || p.split('/').some(x => !x || x === '..' || (x === '.' && p !== '.')) || p.split('/').some(x => x === '.git')) fail('E_PATH', `noncanonical relative path: ${p}`);
  return p;
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) || ['constructor','__proto__','prototype','toString','valueOf'].includes(value)) fail('E_ID', `invalid identity: ${value}`);
  return value;
}
export function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
/** Write `bytes` to `path` through a temp file and a rename. The file gets
 *  `mode` (default 0600, private), set on the open descriptor before fsync and
 *  rename; a caller replacing someone's file passes its original mode. */
export function atomic(path, bytes, { tempDir = dirname(path), mode = 0o600 } = {}) {
  safePath(path); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Publication may stage in its owned lock directory, outside accepted data.
  safePath(tempDir);
  const temp = join(tempDir, `${basename(path)}.tmp-${randomUUID()}`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, path); syncDir(dirname(path));
}
export const save = (path, obj) => atomic(path, JSON.stringify(obj, null, 2) + '\n');
export function tree(root, { git = false } = {}) {
  safePath(root); const files = {};
  function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (git && dir === root && d.name === '.git') continue;
      const path = join(dir, d.name); safePath(path);
      if (d.isDirectory()) walk(path);
      else if (d.isFile()) { if (fs.statSync(path).nlink !== 1) fail('E_PATH', `hardlink not allowed: ${path}`); files[relative(root, path).split(sep).join('/')] = fs.readFileSync(path).toString('base64'); }
      else fail('E_PATH', `unsupported entry: ${path}`);
    }
  }
  walk(root); return files;
}
export const digest = files => hash(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
export function materialize(root, files) {
  safePath(root); fs.mkdirSync(root, { recursive: true });
  for (const [p, content] of Object.entries(files)) atomic(join(root, relPath(p)), Buffer.from(content, 'base64'));
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Cooperative directory lock. `waitMs` lets a caller queue behind a live
 *  holder for a bounded time; a live holder is never stolen from, whatever its
 *  age. With `reclaimDead`, a lock whose owner is provably gone (reclaimable)
 *  is taken over; otherwise an abandoned lock waits for an explicit unlock. */
export function withLock(path, fn, { waitMs = 0, reclaimDead = false } = {}) {
  safePath(path); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (let delay = 20;; delay = Math.min(delay * 2, 250)) {
    try { fs.mkdirSync(path, { mode: 0o700 }); break; }
    catch(e) {
      if(e.code !== 'EEXIST') throw e;
      if(reclaimDead && reclaim(path)) continue;
      if(Date.now() >= deadline) {
        const owner = lockOwner(join(path, 'owner.json'));
        if(owner?.host === hostname() && !pidAlive(owner.pid)) fail('E_LOCKED', `abandoned lock: ${path} is held by process ${owner.pid}, which is gone; once no oats okf process is running, release it with: oats okf unlock --lock ${quote(path)} --token ${quote(owner.token)} --soul <soul>`);
        if(owner?.host === hostname()) fail('E_LOCKED', `busy lock: ${path} is held by running process ${owner.pid}; try again once it finishes`);
        if(owner) throw Object.assign(new Error(otherHost(path, owner)), { code: 'E_LOCKED', otherHost: true });
        fail('E_LOCKED', `busy or abandoned lock: ${path}; inspect owner.json, never reclaim by age`);
      }
      pause(Math.max(1, Math.min(delay, deadline - Date.now())));
    }
  }
  const owner = { token: randomUUID(), pid: process.pid, host: hostname() };
  save(join(path, 'owner.json'), owner);
  try { return fn(); } finally { if (readJSON(join(path, 'owner.json')).token === owner.token) { fs.rmSync(path, { recursive: true }); syncDir(dirname(path)); } }
}
/** A holder may die between creating a lock and writing its owner. */
const OWNERLESS_LOCK_STALE_MS = 30000;
export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** A lock's owner record, or null when it has none readable. */
function lockOwner(file) {
  try { const o = readJSON(file); return Number.isSafeInteger(o?.pid) && typeof o?.token === 'string' && typeof o?.host === 'string' ? o : null; } catch { return null; }
}
/** What proves `path` (a lock directory, or a reclaim guard file) abandoned:
 *  its owner is a pid of this host that is gone, or it has no readable owner
 *  and is older than OWNERLESS_LOCK_STALE_MS. → that record, or null. */
function abandoned(path, ownerFile) {
  let stat; try { stat = fs.lstatSync(path); } catch { return null; }
  const owner = lockOwner(ownerFile);
  if (owner) return owner.host === hostname() && !pidAlive(owner.pid) ? { token: owner.token } : null;
  return Date.now() - stat.mtimeMs > OWNERLESS_LOCK_STALE_MS ? { ino: stat.ino, mtimeMs: stat.mtimeMs } : null;
}
const same = (now, then) => now && (then.token ? now.token === then.token : now.ino === then.ino && now.mtimeMs === then.mtimeMs);
/** Remove the lock at `path` if its owner is provably gone. Reclaimers are
 *  serialized by the guard file `<path>.reclaim` and check the lock again under
 *  it, so a paused reclaimer never removes a lock a live process took since. A
 *  guard whose own holder died is never removed (that would race exactly as
 *  removing the lock does): it is refused, naming it. → whether it was removed. */
function reclaim(path) {
  const stale = abandoned(path, join(path, 'owner.json'));
  if (!stale) return false;
  const guard = `${path}.reclaim`, me = { token: randomUUID(), pid: process.pid, host: hostname() };
  try { fs.writeFileSync(guard, JSON.stringify(me) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (abandoned(guard, guard)) fail('E_LOCKED', `${guard} was left by a process that died while reclaiming ${path}; remove it once no oats okf process is running`);
    return false;
  }
  try {
    if (!same(abandoned(path, join(path, 'owner.json')), stale)) return false;
    fs.rmSync(path, { recursive: true }); syncDir(dirname(path)); return true;
  } finally { if (lockOwner(guard)?.token === me.token) fs.rmSync(guard, { force: true }); }
}
/** The refusal for a lock whose owner is on another host: its process cannot
 *  be probed from here, so only the operator can say that host is gone. */
const otherHost = (path, owner) => `lock ${path} is held by process ${owner.pid} on host ${JSON.stringify(owner.host)}, not this host (${JSON.stringify(hostname())}), and a process on another host cannot be checked from here; it is never released automatically or by age. If that host still runs, wait for it. If it is gone for good (a recreated container, a retired machine) and no oats okf process uses this lock, release it with: oats okf unlock --lock ${quote(path)} --token ${quote(owner.token)} --host-gone ${quote(owner.host)} --soul <soul>`;
/** Release an abandoned lock, by its token. A lock of this host is released
 *  once its process is gone. A lock of another host (#142: a recreated
 *  container has a new hostname) is released only with `hostGone` equal to the
 *  owner's host: the operator's statement that the host is gone. Its pid is
 *  another host's, so it is not probed. */
export function unlock(path, token, hostGone) {
  safePath(path); const o = lockOwner(join(path, 'owner.json'));
  if (!o) {
    // Never advise removing a path that is not plainly a lock (#142 review):
    // a mistyped --lock may name the base itself.
    let stat = null; try { stat = fs.lstatSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!stat) fail('E_NOT_FOUND', `no lock at ${path}; nothing to release`);
    if (!stat.isDirectory() || !/\.(okf-)?lock$/.test(path)) fail('E_USAGE', `${path} is not an oats okf lock (a directory named *.okf-lock or *.lock that holds owner.json); nothing was released`);
    fail('E_LOCKED', `lock ${path} has no readable owner.json (token, pid and host), so no token can release it; nothing was released. Once no oats okf process that shares it is running, on this or any other host, remove that lock directory by hand`);
  }
  if (!token || o.token !== token) fail('E_LOCKED', 'explicit matching lock token required: --token is the token in the lock\'s owner.json');
  const local = o.host === hostname();
  if (hostGone !== undefined) {
    if (typeof hostGone !== 'string' || !hostGone) fail('E_USAGE', '--host-gone needs the host named in the lock\'s owner.json');
    if (local) fail('E_LOCKED', `--host-gone is for a lock held on another host; this lock's owner is this host (${JSON.stringify(o.host)}): drop --host-gone`);
    if (hostGone !== o.host) fail('E_LOCKED', `--host-gone ${JSON.stringify(hostGone)} is not the lock's owner host (${JSON.stringify(o.host)}); nothing was released`);
  } else if (!local) fail('E_LOCKED', otherHost(path, o));
  if (local && pidAlive(o.pid)) fail('E_LOCKED', 'lock owner is still alive');
  fs.rmSync(path, { recursive: true }); syncDir(dirname(path)); return { unlocked: path };
}
export const identityKeys = ['OATS_INSTANCE','OATS_INSTANCE_HOME','OATS_HOME','PI_AGENT_HOME','PI_AGENT_NAME','PI_AGENT_INSTANCE','PI_AGENTS_ROOT','OATS_ROOT','OATS_SOUL','OATS_SOUL_ID','OATS_AGENT','OATS_KIND','OATS_EVENT','OATS_CONTEXT','OATS_REPO','OATS_WORK','OATS_BRANCH','OATS_META','OATS_SETTINGS','OATS_SETTINGS_ORIGINS','OATS_BINDING_FILE','OATS_SOURCE_RECEIPT_FILE','OATS_INVOCATION_CONTEXT_FILE','OATS_DEPLOYMENT','OATS_RESOLUTION'];
export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(OATS_(?!HOME_DIR$|PACKAGE_CATALOG$)|PI_AGENT|GIT_)/.test(k)));
}
// `trim: false` returns stdout byte for byte, for output whose whitespace is data.
export function exec(bin, args, { cwd, env = cleanEnv(), timeout = 30000, maxBuffer = 16*1024*1024, acceptedStatus = [0], input, trim = true } = {}) {
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer, input });
  if(r.error || !acceptedStatus.includes(r.status)) throw Object.assign(new Error(`${bin} ${args[0]} failed: ${r.error?.message || r.stderr || `exit ${r.status}`}`),{code:'E_COMMAND',stdout:r.stdout,status:r.status});
  return trim ? r.stdout.trim() : r.stdout;
}
export function cliPath() {
  const p = process.env.OATS_CLI_BIN;
  if (!p || !isAbsolute(p)) fail('E_RUNTIME', 'absolute OATS_CLI_BIN required; never resolve oats on PATH');
  return p;
}
export function oats(args, cwd, { native = false, ...opts } = {}) {
  let text;
  try {text = exec(cliPath(), args, { cwd, ...opts });}
  catch(e) {
    let response;try {response=JSON.parse(e.stdout);} catch { /* unknown side effect, preserve command failure */ }
    if(response?.schemaVersion===1 && response.ok===false) fail(response.error?.code || 'E_RUNTIME',response.error?.message || 'CLI failed');
    throw e;
  }
  let o; try { o = JSON.parse(text); } catch { fail('E_RUNTIME', 'unsupported CLI JSON response'); }
  if(native) return o;
  if(o.schemaVersion !== 1 || o.ok !== true) fail(o.error?.code || 'E_RUNTIME', o.error?.message || 'unsupported CLI envelope');
  return o.result;
}
export const quote = v => `'${String(v).replaceAll("'", "'\\''")}'`;
export function command(cwd, argv) {
  return `cd ${quote(cwd)} && env ${identityKeys.map(k => `-u ${quote(k)}`).join(' ')} ${[cliPath(), ...argv].map(quote).join(' ')}`;
}
