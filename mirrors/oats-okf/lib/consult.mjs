// okf 3.0.0 consult: souls read their knowledge REMOTELY, at the accepted
// state, with no per-instance copy. The only local bytes are one host-wide bare
// partial clone per Git base (blobs arrive on first read) under the bindings'
// stateDir; directory bases are read in place under their cooperative lock.
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fs, join, dirname, resolve, safePath, readJSON, save, digest, tree, withLock, fail, syncDir, identifier, relPath, within, displayRepo, hash, exec } from './io.mjs';
import { noGit, gitTimeoutMs, consultMaxAgeMs, splitRef, resolveNodes, resolveSubjects } from './config.mjs';
import { git, gitEnv, validateBase, staleWarning, baseLock, journalPath, preflightLocalRepository, requireNotShallow, verifyRemote, unavailable } from './stores.mjs';
import { layoutOf, parseFrontmatter, parseView, plainText, parseSubjectsIndex, counts as viewCounts, subjectFile, viewFile, subjectOfPath, SUBJECT_REF, KINDS } from './okf-reindex.mjs';
import { verdictLanes } from './verdicts.mjs';

const HIT_LIMIT = 50, SNIPPET = 200, FRONTMATTER_BYTES = 8 * 1024, TEXT_BYTES = 64 * 1024 * 1024;
const WALK_FILES = 20000, WALK_BYTES = 256 * 1024 * 1024, DIRECTORY_WAIT_MS = 30000, LOCAL_GIT_MS = 30000;
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- paths
/** Resolve a user path or OKF link to a canonical path relative to the base
 *  root ('' is the root). `/node/x.md` is base-root absolute, a relative path
 *  resolves against the directory of `from` (itself a base path), and a bare
 *  path without `from` resolves from the root. Nothing may leave the root. */
export function resolveBasePath(input, { from = null, fsRoots = [] } = {}) {
  if (typeof input !== 'string' || !input.trim()) fail('E_USAGE', 'a base path is required, for example /node/index.md');
  const raw = input.trim();
  if (/[\0\\]/.test(raw)) fail('E_PATH', `not a base path: ${JSON.stringify(input)}`);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) fail('E_PATH', `${input} is a URL, not a path in the knowledge base`);
  let decoded;
  try { decoded = decodeURIComponent(raw.replace(/[?#].*$/, '')); } catch { fail('E_PATH', `malformed percent-encoding in ${input}`); }
  if (!decoded || /[\0\\]/.test(decoded)) fail('E_PATH', `not a base path: ${JSON.stringify(input)}`);
  for (const root of fsRoots.filter(Boolean)) if (decoded === root || decoded.startsWith(root + '/')) fail('E_PATH', `${input} is a filesystem path; base paths start at the base root, like /node/concept.md`);
  const segments = decoded.startsWith('/') ? decoded.slice(1).split('/')
    : from !== null ? [...from.split('/').slice(0, -1), ...decoded.split('/')] : decoded.split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (!out.length) fail('E_PATH', `${input} escapes the base root`); out.pop(); continue; }
    if (segment.startsWith('.')) fail('E_PATH', `${input}: hidden paths are not knowledge`);
    out.push(segment);
  }
  return out.join('/');
}
const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const shown = p => '/' + p;

// ---------------------------------------------------------------- git cache
export const cacheDir = (bindings, base) => join(bindings.stateDir, 'cache', `${identifier(base.id)}.git`);
export const cacheLock = (bindings, base) => join(bindings.stateDir, 'cache', `${base.id}.lock`);
const stateFile = cache => join(cache, 'okf-consult.json');
// GIT_ALLOW_PROTOCOL also blocks implicit promisor fetches on Git versions
// predating GIT_NO_LAZY_FETCH. Offline checks must never turn into network I/O.
const readEnv = offline => offline ? { ...gitEnv(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' } : gitEnv();
function gitRun(cwd, args, { input, timeout = LOCAL_GIT_MS, maxBuffer = TEXT_BYTES, encoding = 'utf8', offline = false } = {}) {
  return spawnSync('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-C', cwd, ...args],
    { cwd, env: readEnv(offline), input, timeout, maxBuffer, encoding });
}
const gitError = r => Object.assign(new Error(`git failed: ${r.error?.message || r.stderr || `exit ${r.status}`}`), { code: r.error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'E_COMMAND' });
export function acceptedCommit(cache, base, { offline = false } = {}) {
  const r = gitRun(cache, ['rev-parse', '--verify', '--quiet', `refs/heads/${base.acceptedBranch}^{commit}`], { offline });
  const oid = r.status === 0 ? r.stdout.trim() : '';
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ? oid : null;
}
/** The cache's bookkeeping, or null when the cache is absent or belongs to a
 *  different repository/branch (then it is rebuilt, never reinterpreted). */
export function usableCache(cache, base, { offline = false } = {}) {
  if (!fs.existsSync(cache)) return null;
  safePath(cache);
  let state;
  try { state = readJSON(stateFile(cache)); } catch { return null; }
  if (!obj(state) || state.version !== 1 || state.repository !== base.repository || state.acceptedBranch !== base.acceptedBranch) return null;
  try { verifyRemote(base, cache); } catch { return null; }
  return acceptedCommit(cache, base, { offline }) ? state : null;
}
function cloneCache(base, alias, dest) {
  preflightLocalRepository(base, alias);
  // --no-local: a local path gets the same filtered transport as a remote
  // (git ignores --filter for local clones and would copy every object).
  const args = ['clone', '--bare', ...(base.repository.startsWith('/') ? ['--no-local'] : []), '--single-branch', '--branch', base.acceptedBranch];
  try { git(dirname(dest), [...args, '--filter=blob:none', '--', base.repository, dest], { timeout: gitTimeoutMs() }); }
  catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    if (!(e.code === 'E_COMMAND' && /filter/i.test(e.message))) unavailable(base, alias, 'clone', e);
    try { git(dirname(dest), [...args, '--', base.repository, dest], { timeout: gitTimeoutMs() }); }
    catch (error) { unavailable(base, alias, 'clone', error); }
  }
  try { requireNotShallow(base, alias, dest); } catch (e) { if (e.code === 'E_BASE_SHALLOW') throw e; unavailable(base, alias, 'clone', e); }
  verifyRemote(base, dest);
  if (!acceptedCommit(dest, base)) unavailable(base, alias, 'clone', new Error(`accepted branch ${base.acceptedBranch} not found`));
}
function fetchAccepted(base, alias, cache) {
  // Only the accepted branch, forced to what the remote accepts now.
  try { git(cache, ['fetch', '--no-tags', '--update-head-ok', 'origin', `+refs/heads/${base.acceptedBranch}:refs/heads/${base.acceptedBranch}`], { timeout: gitTimeoutMs() }); }
  catch (e) { unavailable(base, alias, 'fetch', e); }
  try { requireNotShallow(base, alias, cache); } catch (e) { if (e.code === 'E_BASE_SHALLOW') throw e; unavailable(base, alias, 'fetch', e); }
  verifyRemote(base, cache);
}
function gitContext(bindings, alias, base, cache, state, { offline = false } = {}) {
  const commit = acceptedCommit(cache, base, { offline });
  if (!commit) unavailable(base, alias, 'fetch', new Error('cached accepted branch is missing'));
  const receipt = { base: alias, id: base.id, kind: 'git', commit, fetchedAt: state.fetchedAt, stale: !!state.error };
  if (state.error) receipt.reason = state.error;
  return { alias, base, bindings, kind: 'git', cache, commit, receipt };
}
function resolveGit(bindings, alias, base, { fresh = false, preferCached = false } = {}) {
  const cache = cacheDir(bindings, base), lock = cacheLock(bindings, base);
  fs.mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  const due = s => fresh || Date.now() - Math.max(Date.parse(s.fetchedAt) || 0, Date.parse(s.attemptedAt) || 0) >= consultMaxAgeMs();
  const cachedContext = state => ({ ...gitContext(bindings, alias, base, cache, state, { offline: preferCached }), ...(preferCached ? { offline: true, refreshDue: due(state) } : {}) });
  let state = usableCache(cache, base, { offline: preferCached });
  // Spawn reuses the last accepted commit without renewing its freshness or
  // clearing a failed-fetch receipt. A due node/owner resolution failure may
  // retry normal resolution; successful spawns leave freshness to consultation.
  if (state && (preferCached || !due(state))) return cachedContext(state);
  clearDeadCacheLock(lock);
  try {
    return withLock(lock, () => {
      state = usableCache(cache, base, { offline: preferCached });
      if (state && (preferCached || !due(state))) return cachedContext(state); // a peer just fetched
      const now = new Date().toISOString();
      if (!state) {
        const temp = join(dirname(cache), `.${base.id}.git.tmp-${randomUUID()}`);
        try {
          cloneCache(base, alias, temp);
          const created = { version: 1, repository: base.repository, acceptedBranch: base.acceptedBranch, fetchedAt: now, attemptedAt: now, error: null };
          save(stateFile(temp), created);
          // Readers only ever see a complete cache: build aside, then rename.
          const old = fs.existsSync(cache) ? `${cache}.old-${randomUUID()}` : null;
          if (old) fs.renameSync(cache, old);
          fs.renameSync(temp, cache); syncDir(dirname(cache));
          if (old) fs.rmSync(old, { recursive: true, force: true });
          return gitContext(bindings, alias, base, cache, created);
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      }
      try { fetchAccepted(base, alias, cache); state = { ...state, fetchedAt: now, attemptedAt: now, error: null }; }
      catch (e) {
        if (e.code !== 'E_BASE_UNAVAILABLE') throw e;
        // Serve the last fetched accepted commit, loudly; retry after max-age or --fresh.
        state = { ...state, attemptedAt: now, error: `fetch of the accepted branch failed at ${now} (reason: ${e.reason || 'unknown'}); serving the last fetched accepted commit` };
      }
      save(stateFile(cache), state);
      return gitContext(bindings, alias, base, cache, state);
    }, { waitMs: state ? Math.min(gitTimeoutMs(), 60000) : gitTimeoutMs() }); // a cached commit can be served sooner
  } catch (e) {
    if (e.code === 'E_LOCKED' && state) return gitContext(bindings, alias, base, cache, { ...state, error: `host cache lock is busy (${lock}); serving the last fetched accepted commit` });
    throw e;
  }
}
/** The cache is disposable host state, not accepted custody: a lock whose
 *  owner process on this host is gone is released (an interrupted clone is
 *  built aside and never renamed in; an interrupted fetch leaves refs whole).
 *  A live, foreign-host or unreadable owner is always waited for. */
export function clearDeadCacheLock(lock) {
  let owner; try { owner = readJSON(join(lock, 'owner.json')); } catch { return; }
  if (owner?.host !== hostname() || !Number.isInteger(owner.pid)) return;
  try { process.kill(owner.pid, 0); } catch (e) {
    if (e.code !== 'ESRCH') return;
    let current; try { current = readJSON(join(lock, 'owner.json')); } catch { return; }
    if (current?.token === owner.token) fs.rmSync(lock, { recursive: true, force: true }); // still the dead owner's lock
  }
}
const repoPath = (ctx, p) => ctx.base.root === '.' ? p : (p ? `${ctx.base.root}/${p}` : ctx.base.root);
const basePathOf = (ctx, p) => ctx.base.root === '.' ? p : p.slice(ctx.base.root.length + 1);
function lsTree(ctx, p, { recursive = false } = {}) {
  const r = gitRun(ctx.cache, ['ls-tree', '-z', ...(recursive ? ['-r'] : []), `${ctx.commit}:${repoPath(ctx, p)}`], { offline: !!ctx.offline });
  if (r.status !== 0) throw gitError(r);
  return r.stdout.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, type, oid] = line.slice(0, tab).split(' ');
    return { name: line.slice(tab + 1), mode, type, oid };
  });
}
function gitEntry(ctx, p) {
  if (!p) return { type: 'dir' };
  const r = gitRun(ctx.cache, ['ls-tree', '-z', ctx.commit, '--', repoPath(ctx, p)]);
  if (r.status !== 0) throw gitError(r);
  const line = r.stdout.split('\0').filter(Boolean)[0];
  if (!line) return null;
  const tab = line.indexOf('\t'), [mode, type, oid] = line.slice(0, tab).split(' ');
  if (line.slice(tab + 1) !== repoPath(ctx, p)) return null;
  if (mode === '040000' && type === 'tree') return { type: 'dir', oid };
  if (['100644', '100755'].includes(mode) && type === 'blob') return { type: 'file', oid };
  fail('E_PATH', `${ctx.alias}${shown(p)}: symlink or submodule in knowledge base is not allowed`);
}
/** One batched fetch for the blobs a command is about to read, instead of one
 *  lazy round trip per blob. Best effort: a failure surfaces on the read. */
function prefetch(ctx, p, only = null) {
  const r = gitRun(ctx.cache, ['rev-list', '--objects', '--missing=print', `${ctx.commit}:${repoPath(ctx, p)}`]);
  if (r.status !== 0) return;
  const missing = r.stdout.split('\n').filter(l => l.startsWith('?')).map(l => l.slice(1).trim()).filter(oid => !only || only.has(oid));
  if (!missing.length) return;
  try {
    withLock(cacheLock(ctx.bindings, ctx.base), () => gitRun(ctx.cache, ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', 'origin', '--stdin'],
      { input: missing.join('\n') + '\n', timeout: gitTimeoutMs() }), { waitMs: gitTimeoutMs() });
  } catch { /* lazy reads remain authoritative */ }
}
function gitBlob(ctx, oid, p, { limit } = {}) {
  const r = gitRun(ctx.cache, ['cat-file', 'blob', oid], { timeout: gitTimeoutMs(), maxBuffer: limit ?? TEXT_BYTES });
  if (r.error?.code === 'ENOBUFS') { if (limit) return r.stdout; fail('E_TOO_LARGE', `${ctx.alias}${shown(p)} exceeds ${TEXT_BYTES} bytes`); }
  if (r.error || r.status !== 0) unavailable(ctx.base, ctx.alias, 'read', gitError(r));
  return r.stdout;
}

// ---------------------------------------------------------------- stores
function dirEntry(ctx, p) {
  const file = safePath(join(ctx.base.path, p));
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
  if (stat.isDirectory()) return { type: 'dir', file };
  if (stat.isFile()) { if (stat.nlink !== 1) fail('E_PATH', `${ctx.alias}${shown(p)}: hardlink not allowed`); return { type: 'file', file }; }
  fail('E_PATH', `${ctx.alias}${shown(p)}: unsupported entry in knowledge base`);
}
function readBounded(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const size = fs.fstatSync(fd).size;
    if (!limit && size > TEXT_BYTES) fail('E_TOO_LARGE', `${file} exceeds ${TEXT_BYTES} bytes`);
    const bytes = Buffer.alloc(Math.min(size, limit ?? size)); let length = 0;
    while (length < bytes.length) { const n = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    return bytes.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
const entry = (ctx, p) => ctx.kind === 'git' ? gitEntry(ctx, p) : dirEntry(ctx, p);
function read(ctx, p, e = entry(ctx, p), opts) { return ctx.kind === 'git' ? gitBlob(ctx, e.oid, p, opts) : readBounded(e.file, opts?.limit); }
function children(ctx, p) {
  const rows = ctx.kind === 'git'
    ? lsTree(ctx, p).map(r => ({ name: r.name, oid: r.oid, type: r.mode === '040000' ? 'dir' : ['100644', '100755'].includes(r.mode) ? 'file' : 'unsupported' }))
    : fs.readdirSync(safePath(join(ctx.base.path, p)), { withFileTypes: true }).map(d => ({ name: d.name, file: join(ctx.base.path, p, d.name), type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'unsupported' }));
  return rows.filter(r => !r.name.startsWith('.')).sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function notFound(ctx, p) {
  let dir = parent(p);
  while (dir && entry(ctx, dir)?.type !== 'dir') dir = parent(dir);
  const rows = children(ctx, dir), names = rows.slice(0, 20).map(r => r.type === 'dir' ? `${r.name}/` : r.name);
  fail('E_NOT_FOUND', `${ctx.alias}${shown(p)} does not exist at ${short(ctx.receipt)}; \`oats okf ls --base ${ctx.alias} ${shown(dir)}\` lists: ${names.join(', ') || '(empty)'}${rows.length > 20 ? `, and ${rows.length - 20} more` : ''}`);
}
function requireFile(ctx, p) {
  if (!p.endsWith('.md')) fail('E_NOT_MARKDOWN', `${ctx.alias}${shown(p)} is not a Markdown file; cat reads only .md concepts (use ls for directories)`);
  const e = entry(ctx, p);
  if (!e) notFound(ctx, p);
  if (e.type !== 'file') fail('E_NOT_MARKDOWN', `${ctx.alias}${shown(p)} is a directory; use ls`);
  return e;
}

/** Run fn against one base at its accepted state. Git: the host cache (fetched
 *  per freshness rules). Directory: in place, under the base lock, refusing a
 *  pending publication exactly as staging does. */
export function withBase(bindings, alias, { fresh = false, preferCached = false } = {}, fn) {
  if (typeof alias !== 'string' || !Object.hasOwn(bindings.bases, alias)) fail('E_BASE_UNKNOWN', `unknown base ${JSON.stringify(alias ?? null)}; bound bases: ${Object.keys(bindings.bases).join(', ')}`);
  const base = bindings.bases[alias];
  if (base.kind === 'git') return fn(resolveGit(bindings, alias, base, { fresh, preferCached }));
  noGit(base.path);
  return withLock(baseLock(base), () => {
    if (fs.existsSync(journalPath(base))) fail('E_RECOVERY', `publication pending: ${journalPath(base)}; retry its recorded run before reading`);
    if (!fs.existsSync(safePath(base.path))) fail('E_BASE_UNAVAILABLE', `directory base "${alias}" is missing at ${base.path}`);
    const ctx = { alias, base, bindings, kind: 'directory' };
    ctx.receipt = { base: alias, id: base.id, kind: 'directory', digest: digest(tree(base.path)), fetchedAt: new Date().toISOString(), stale: false };
    return fn(ctx);
  }, { waitMs: DIRECTORY_WAIT_MS });
}

// ---------------------------------------------------------------- validation
/** A tree entry name, from an untrusted accepted tree, as a path under the base
 *  root. Git accepts literal `..`, absolute-looking and control-character entry
 *  names (`hash-object --literally`), and they survive a partial clone, so every
 *  name gets relPath's canonical rules (no empty, `.`, `..`, absolute, backslash,
 *  NUL or `.git` segment) plus no control characters or percent-escapes. */
export function treeEntryPath(name) {
  const bad = () => fail('E_PATH', `invalid tree entry in knowledge base: ${JSON.stringify(String(name)).slice(0, 200)}`);
  if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name) || /%[0-9a-fA-F]{2}/.test(name)) bad();
  try { return relPath(name); } catch { return bad(); }
}
/** Where a tree entry lands under `root`, refused unless it stays strictly
 *  inside it after resolution (the second, independent guard). */
export function containedTarget(root, name) {
  const target = resolve(root, treeEntryPath(name));
  if (target === resolve(root) || !within(root, target)) fail('E_PATH', `tree entry escapes its materialization root: ${JSON.stringify(name).slice(0, 200)}`);
  return safePath(target);
}
/** Read all validated tree entries with one Git process. Spool its raw output
 *  outside the materialized tree: neither a whole-base Buffer nor a maxBuffer
 *  cap may change which blob sizes validate. Batch framing is byte-oriented,
 *  including newlines, NULs and multibyte UTF-8 inside object bodies. */
function materializeBatch(ctx, rows, spool) {
  if (!rows.length) return;
  const output = fs.openSync(spool, 'wx', 0o600);
  let result;
  try {
    result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-C', ctx.cache, 'cat-file', '--batch'], {
      env: readEnv(!!ctx.offline), input: rows.map(r => r.oid).join('\n') + '\n',
      timeout: gitTimeoutMs(), stdio: ['pipe', output, 'pipe']
    });
  } finally { fs.closeSync(output); }
  if (result.error || result.status !== 0) unavailable(ctx.base, ctx.alias, 'read', gitError(result));
  const fd = fs.openSync(spool, 'r'), header = Buffer.alloc(128), chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  const malformed = () => unavailable(ctx.base, ctx.alias, 'read', new Error('invalid git cat-file batch response'));
  try {
    const total = fs.fstatSync(fd).size;
    for (const row of rows) {
      const n = fs.readSync(fd, header, 0, header.length, position);
      const end = header.subarray(0, n).indexOf(10);
      if (end < 0) malformed();
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9][0-9]*)$/.exec(header.subarray(0, end).toString('latin1'));
      if (!match || match[1] !== row.oid) malformed();
      const size = Number(match[2]); position += end + 1;
      if (!Number.isSafeInteger(size) || size > total - position - 1) malformed();
      fs.mkdirSync(dirname(row.target), { recursive: true });
      const target = fs.openSync(row.target, 'wx', 0o600);
      try {
        let remaining = size;
        while (remaining) {
          const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, remaining), position);
          if (!count) malformed();
          for (let written = 0; written < count;) written += fs.writeSync(target, chunk, written, count - written);
          position += count; remaining -= count;
        }
      } finally { fs.closeSync(target); }
      if (fs.readSync(fd, header, 0, 1, position++) !== 1 || header[0] !== 10) malformed();
    }
    if (position !== total) malformed();
  } finally { fs.closeSync(fd); }
}
const VALIDATION_CODES = new Set(['E_VALIDATION', 'E_BASE', 'E_PATH', 'E_ID', 'E_CONFIG']);
/** Whether the accepted state is a valid OKF base. Git verdicts are cached per
 *  commit inside the host cache; computing one materializes the base root into
 *  a transient host scratch that is removed before returning. */
function validationFile(ctx) { return join(ctx.cache, 'okf-validation', `${ctx.commit}-${hash({ root: ctx.base.root }).slice(0, 16)}.json`); }
export function verdict(ctx, { fetchMissing = true, saveResult = true } = {}) {
  const judge = run => {
    // okf 6.0: version 3 adds `subjects` (null on a plain base) and `stale`
    // (generated files a reader tolerates); an older cached verdict is judged
    // again rather than read without them (a 6.0 pre-release refused staleness).
    try { const v = run(); return { version: 3, ok: true, digest: v.digest, nodes: v.meta.nodes, subjects: v.subjects, stale: v.stale ?? 0 }; }
    catch (e) { if (!VALIDATION_CODES.has(e.code)) throw e; return { version: 3, ok: false, error: { code: e.code, message: e.message } }; }
  };
  if (ctx.kind === 'directory') return judge(() => validateBase(ctx.base.path, ctx.base, { reader: true }));
  const file = validationFile(ctx);
  if (fs.existsSync(file)) { const cached = readJSON(file); if (cached?.version === 3 && cached.commit === ctx.commit && cached.root === ctx.base.root) return cached; }
  const scratch = fs.mkdtempSync(join(saveResult ? dirname(ctx.cache) : fs.realpathSync(tmpdir()), saveResult ? '.validate-' : 'okf-validate-'));
  const root = join(scratch, 'tree');
  // Also used by offline inspection: never lazy-fetch while checking objects.
  if (!fetchMissing) ctx = { ...ctx, offline: true };
  try {
    fs.mkdirSync(root);
    const result = judge(() => {
      const rows = lsTree(ctx, '', { recursive: true });
      // Every entry is judged before anything is written: the first bad name or
      // mode refuses the whole base, and nothing lands outside the scratch.
      for (const r of rows) {
        if (!['100644', '100755'].includes(r.mode) || r.type !== 'blob') fail('E_PATH', 'symlink or submodule in knowledge base is not allowed');
        r.target = containedTarget(root, r.name);
      }
      if (fetchMissing) prefetch(ctx, '');
      else {
        const missing = gitRun(ctx.cache, ['rev-list', '--objects', '--missing=print', `${ctx.commit}:${repoPath(ctx, '')}`], { offline: true });
        if (missing.status !== 0) throw gitError(missing);
        if (missing.stdout.split('\n').some(line => line.startsWith('?'))) unavailable(ctx.base, ctx.alias, 'read', new Error('cached validation needs missing objects'));
      }
      materializeBatch(ctx, rows, join(scratch, 'objects'));
      return validateBase(root, ctx.base, { reader: true });
    });
    if (saveResult) save(file, { ...result, commit: ctx.commit, root: ctx.base.root, at: new Date().toISOString() });
    return result;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
/** Registration's accepted resolution: per base, the accepted commit/digest and
 *  its nodes, validated, and the soul's declaration resolved against them. No
 *  files are materialized for the instance. */
export function acceptedResolution(bindings, decl) {
  const view = {}, accepted = {};
  for (const alias of Object.keys(bindings.bases)) withBase(bindings, alias, {}, ctx => {
    const v = verdict(ctx);
    if (!v.ok) fail(v.error.code, `base "${alias}" at ${short(ctx.receipt)}: ${v.error.message}`);
    accepted[alias] = { nodes: v.nodes, subjects: v.subjects };
    view[alias] = { ...ctx.receipt, digest: v.digest, nodes: v.nodes };
  });
  resolveNodes(decl, bindings, accepted);
  resolveSubjects(decl, bindings, accepted);
  return view;
}

// ---------------------------------------------------------------- helpers
function nodesOf(ctx) {
  let m;
  const e = entry(ctx, 'okf-base.json');
  try { m = JSON.parse(e ? read(ctx, 'okf-base.json', e) : ''); } catch { fail('E_BASE', `base "${ctx.alias}" has no valid okf-base.json at ${short(ctx.receipt)}`); }
  if (!obj(m?.nodes)) fail('E_BASE', `base "${ctx.alias}" okf-base.json has no nodes`);
  return m.nodes;
}
function nodePath(ctx, node) {
  const nodes = nodesOf(ctx);
  if (!Object.hasOwn(nodes, node) || typeof nodes[node]?.path !== 'string') fail('E_NOT_FOUND', `base "${ctx.alias}" has no node "${node}"; nodes: ${Object.keys(nodes).join(', ')}`);
  return resolveBasePath(nodes[node].path);
}
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(type|title|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2').slice(0, 300);
  }
  return out;
}
export function markdownLinks(text) {
  const clean = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
  const links = [], seen = new Set();
  const add = (label, target) => { if (!target || seen.has(target)) return; seen.add(target); links.push({ text: label, target }); };
  for (const m of clean.matchAll(/!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(m[1], m[2]);
  for (const m of clean.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)) add(m[1], m[2]);
  return links;
}
function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 5 ? 'just now' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
export const short = r => `${r.base}@${r.kind === 'git' ? r.commit.slice(0, 12) : `dir:${r.digest.slice(0, 12)}`}`;
export const footer = receipts => receipts.map(r => `— ${short(r)} (fetched ${age(r.fetchedAt)}${r.stale ? `; STALE: ${r.reason}` : ''})`).join('\n');
const fsRoots = (source, ctx) => [source.home, source.work, source.bindings.stateDir, dirname(source.bindings.file), ctx.kind === 'directory' ? ctx.base.path : null];
const refsOf = decl => [...decl.owns.map(ref => [ref, 'owns']), ...decl.reads.filter(ref => !decl.owns.includes(ref)).map(ref => [ref, 'reads'])];
function needBase(source, flags) {
  if (!flags.base) fail('E_USAGE', `--base ALIAS is required; bound bases: ${Object.keys(source.bindings.bases).join(', ')}`);
  return flags.base;
}
function onePath(positionals, label) {
  if (positionals.length !== 1) fail('E_USAGE', `expected one ${label}`);
  return positionals[0];
}

// ---------------------------------------------------------------- protection
// oats.okf 6.0: every Git base's accepted branch should take changes by PR
// only, merged by the knowledge maintainer. Two read-only, best-effort GitHub
// reads per base report it; they never refuse anything. The branch rules
// endpoint shows rulesets only, so classic branch protection is read too:
// GitHub answers 404 "Branch not protected" when the caller may read it and
// there is none, and 404 "Not Found" (or 403) when the caller may not.
// enforced: a ruleset, or classic protection, requires a PR or restricts
// pushes; none: both reads succeeded and neither does (classic protection with
// status checks only included); unknown otherwise.
/** What `protection` answers, printed with every Git base by `oats okf bases`. */
export const PROTECTION_MEANING = 'protection answers "can anyone but a reviewer land a change on the accepted branch?": enforced = a readable ruleset or classic rule requires a pull request or restricts who may push; none = both reads succeeded and neither does (classic protection with status checks only included: it gates nothing); unknown = neither read shows such a rule and at least one read failed, or the base is not on GitHub. It does not check approval counts, bypass lists or who the maintainer is';
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/;
export function protection(base, { run = (args, timeout) => exec('gh', args, { timeout }) } = {}) {
  if (base.kind !== 'git' || !GITHUB_REMOTE.test(base.repository)) return 'unknown';
  const repo = `repos/${base.pr.repository}`, branch = base.acceptedBranch;
  let rules = null;
  try { const v = JSON.parse(run(['api', `${repo}/rules/branches/${branch}`], gitTimeoutMs())); if (Array.isArray(v)) rules = v; } catch { /* unreadable */ }
  // A rule that forbids updates outside a PR, or restricts who may push.
  if (rules?.some(r => r && ['pull_request', 'update'].includes(r.type))) return 'enforced';
  let classic = 'unreadable';
  try {
    const v = JSON.parse(run(['api', `${repo}/branches/${branch}/protection`], gitTimeoutMs()));
    // The same predicate as the rulesets': a required PR review, or restricted
    // pushers. Classic protection without either (status checks only) does
    // not gate direct pushes, so it establishes nothing.
    const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
    if (obj(v) && typeof v.url === 'string') classic = obj(v.required_pull_request_reviews) || obj(v.restrictions) ? 'gated' : 'absent';
  } catch (e) {
    let body = null; try { body = JSON.parse(String(e?.stdout ?? '')); } catch { /* not GitHub's answer */ }
    if (body?.message === 'Branch not protected') classic = 'absent';
  }
  if (classic === 'gated') return 'enforced';
  return rules && classic === 'absent' ? 'none' : 'unknown';
}

// ---------------------------------------------------------------- commands
export function bases(source, flags) {
  const rows = [], receipts = [];
  for (const [alias, base] of Object.entries(source.bindings.bases)) withBase(source.bindings, alias, { fresh: !!flags.fresh }, ctx => {
    const v = verdict(ctx), mine = relation => source.decl[relation].filter(ref => splitRef(ref)[0] === alias).map(ref => splitRef(ref)[1]);
    rows.push({ alias, id: base.id, kind: base.kind, ...(base.kind === 'git' ? { repository: displayRepo(base.repository), acceptedBranch: base.acceptedBranch, root: base.root, commit: ctx.commit, protection: protection(base) } : { path: base.path, digest: ctx.receipt.digest }),
      fetchedAt: ctx.receipt.fetchedAt, stale: ctx.receipt.stale, ...(ctx.receipt.reason ? { reason: ctx.receipt.reason } : {}),
      validated: v.ok ? { ok: true } : { ok: false, error: v.error }, nodes: v.ok ? Object.keys(v.nodes) : null, layout: v.ok ? (v.subjects ? 'subjects' : 'plain') : null, ...(v.ok && v.subjects ? { subjects: v.subjects.length } : {}), owns: mine('owns'), reads: mine('reads'), receipt: ctx.receipt });
    receipts.push(ctx.receipt);
  });
  const text = rows.map(r => `${r.alias} (${r.kind}) ${r.kind === 'git' ? `${r.repository} ${r.acceptedBranch} root=${r.root} protection: ${r.protection}` : r.path}\n  accepted ${short(r.receipt)} fetched ${age(r.fetchedAt)}${r.stale ? ` STALE: ${r.reason}` : ''}; ${r.validated.ok ? `valid OKF base${r.layout === 'subjects' ? `, subject layout (${r.subjects} subjects)` : ''}` : `INVALID: ${r.validated.error.message}`}\n  owns: ${r.owns.join(', ') || '-'}; reads: ${r.reads.join(', ') || '-'}${r.nodes ? `; nodes: ${r.nodes.join(', ')}` : ''}`).join('\n');
  const git = rows.some(r => r.kind === 'git');
  return { result: { bases: rows, ...(git ? { protectionMeaning: PROTECTION_MEANING } : {}) }, text: `${text}\n${git ? `${PROTECTION_MEANING}\n` : ''}${footer(receipts)}` };
}
export function index(source, flags, positionals) {
  if (positionals.length > 1) fail('E_USAGE', 'index takes at most one node or subject');
  // okf 6.0: a subject ref (unless its kind is a bound alias), or a v2
  // declaration with no argument, reads generated subject indexes.
  const subjectRef = positionals.length === 1 && isSubjectArg(source, positionals[0]) ? positionals[0] : null;
  if (subjectRef || (!positionals.length && !flags.base && source.decl.version === 2)) return subjectIndexes(source, flags, subjectRef ? [subjectRef] : source.decl.subjects);
  let targets;
  const relation = (alias, node) => refsOf(source.decl).find(([ref]) => ref === `${alias}/${node}`)?.[1] ?? null;
  if (positionals.length) {
    let alias = flags.base, node = positionals[0];
    if (node.includes('/')) { const [a, n] = splitRef(node); if (alias && alias !== a) fail('E_USAGE', `--base ${alias} disagrees with ${node}`); alias = a; node = n; }
    else if (!alias) {
      const matches = refsOf(source.decl).filter(([ref]) => splitRef(ref)[1] === node);
      if (matches.length !== 1) fail('E_USAGE', matches.length ? `node "${node}" is in several bases (${matches.map(([r]) => r).join(', ')}); pass --base ALIAS` : `node "${node}" is not one of your nodes (${refsOf(source.decl).map(([r]) => r).join(', ') || 'none'}); pass --base ALIAS`);
      alias = splitRef(matches[0][0])[0];
    }
    targets = [{ alias, node }];
  } else if (flags.base) targets = [{ alias: flags.base, node: null }];
  else targets = refsOf(source.decl).map(([ref]) => { const [alias, node] = splitRef(ref); return { alias, node }; });
  if (!targets.length) fail('E_USAGE', 'this soul owns and reads no nodes; pass --base ALIAS [node]');
  const indexes = [], receipts = [];
  for (const alias of [...new Set(targets.map(t => t.alias))]) withBase(source.bindings, alias, { fresh: !!flags.fresh }, ctx => {
    receipts.push(ctx.receipt);
    for (const t of targets.filter(t => t.alias === alias)) {
      const path = t.node ? `${nodePath(ctx, t.node)}/index.md` : 'index.md', e = requireFile(ctx, path);
      indexes.push({ base: alias, node: t.node, relation: t.node ? relation(alias, t.node) : null, path, text: read(ctx, path, e), receipt: ctx.receipt });
    }
  });
  const order = new Map(targets.map((t, i) => [`${t.alias}/${t.node}`, i]));
  indexes.sort((a, b) => order.get(`${a.base}/${a.node}`) - order.get(`${b.base}/${b.node}`));
  const text = indexes.map(x => `## ${x.node ? `${x.base}/${x.node}` : x.base}${x.relation ? ` (${x.relation})` : ''}\n\n${x.text.trimEnd()}\n`).join('\n');
  return { result: { indexes }, text: `${text}\n${footer(receipts)}` };
}
export function cat(source, flags, positionals) {
  const input = onePath(positionals, 'path');
  return withBase(source.bindings, needBase(source, flags), { fresh: !!flags.fresh }, ctx => {
    const roots = fsRoots(source, ctx);
    const from = flags.from === undefined ? null : resolveBasePath(flags.from, { fsRoots: roots });
    const path = resolveBasePath(input, { from, fsRoots: roots }), e = requireFile(ctx, path);
    const text = read(ctx, path, e);
    return { result: { path, text, receipt: ctx.receipt }, text: `${text.trimEnd()}\n${footer([ctx.receipt])}` };
  });
}
export function ls(source, flags, positionals) {
  if (positionals.length > 1) fail('E_USAGE', 'ls takes at most one directory');
  return withBase(source.bindings, needBase(source, flags), { fresh: !!flags.fresh }, ctx => {
    const path = positionals.length ? resolveBasePath(positionals[0], { fsRoots: fsRoots(source, ctx) }) : '';
    const e = entry(ctx, path);
    if (!e) notFound(ctx, path);
    if (e.type !== 'dir') fail('E_USAGE', `${ctx.alias}${shown(path)} is a file; use cat`);
    const rows = children(ctx, path);
    if (ctx.kind === 'git') prefetch(ctx, path, new Set(rows.filter(r => r.type === 'file' && r.name.endsWith('.md')).map(r => r.oid)));
    const entries = rows.map(r => {
      const p = path ? `${path}/${r.name}` : r.name, out = { name: r.name, path: p, kind: r.type };
      if (r.type === 'file' && r.name.endsWith('.md')) {
        const fm = frontmatter(ctx.kind === 'git' ? gitBlob(ctx, r.oid, p, { limit: FRONTMATTER_BYTES }) : readBounded(safePath(r.file), FRONTMATTER_BYTES));
        if (fm) Object.assign(out, fm);
      }
      return out;
    });
    const text = entries.map(x => {
      if (x.kind === 'dir') return `${x.name}/`;
      if (x.kind === 'unsupported') return `${x.name}  (unsupported entry, refused)`;
      const meta = [x.type ? `[${x.type}]` : '', x.title, x.description ? `— ${x.description}` : ''].filter(Boolean).join(' ');
      return meta ? `${x.name}  ${meta}` : x.name;
    }).join('\n');
    return { result: { path, entries, receipt: ctx.receipt }, text: `${shown(path)}\n${text || '(empty)'}\n${footer([ctx.receipt])}` };
  });
}
export function links(source, flags, positionals) {
  const input = onePath(positionals, 'path');
  return withBase(source.bindings, needBase(source, flags), { fresh: !!flags.fresh }, ctx => {
    const roots = fsRoots(source, ctx), path = resolveBasePath(input, { fsRoots: roots }), e = requireFile(ctx, path);
    const rows = markdownLinks(read(ctx, path, e)).filter(l => !l.target.startsWith('#')).map(l => {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(l.target) || l.target.startsWith('//')) return { ...l, external: true };
      try {
        const p = resolveBasePath(l.target, { from: path, fsRoots: roots }), found = p ? entry(ctx, p) : { type: 'dir' };
        return { ...l, path: p, exists: !!found, ...(found?.type === 'dir' ? { directory: true } : {}) };
      } catch (err) { if (!['E_PATH', 'E_USAGE'].includes(err.code)) throw err; return { ...l, exists: false, refused: err.message }; }
    });
    const text = rows.map(r => r.external ? `external  ${r.target}` : r.refused ? `REFUSED   ${r.target} (${r.refused})` : `${r.exists ? 'ok       ' : 'MISSING  '} ${shown(r.path)}${r.target !== shown(r.path) ? `  (${r.target})` : ''}`).join('\n');
    return { result: { path, links: rows, receipt: ctx.receipt }, text: `${shown(path)} links:\n${text || '(none)'}\n${footer([ctx.receipt])}` };
  });
}
function matcher(query, { regex, caseSensitive }) {
  if (regex) { let re; try { re = new RegExp(query, caseSensitive ? '' : 'i'); } catch (e) { fail('E_USAGE', `invalid --regex: ${e.message}`); } return line => { const m = re.exec(line); return m ? m.index : -1; }; }
  const needle = caseSensitive ? query : query.toLowerCase();
  return line => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}
function snippet(line, at) {
  const text = line.trim(), offset = Math.max(0, (at ?? 0) - (line.length - line.trimStart().length) - 60);
  const cut = text.length <= SNIPPET ? text : text.slice(offset, offset + SNIPPET);
  return `${offset > 0 && text.length > SNIPPET ? '…' : ''}${cut}${offset + SNIPPET < text.length ? '…' : ''}`;
}
function searchBase(ctx, prefix, query, opts, hits) {
  const find = matcher(query, opts);
  if (ctx.kind === 'git') {
    prefetch(ctx, prefix);
    const r = gitRun(ctx.cache, ['grep', '-z', '-n', '-I', '--no-color', ...(opts.regex ? ['-E'] : ['-F']), ...(opts.caseSensitive ? [] : ['-i']), '-e', query, ctx.commit, '--', repoPath(ctx, prefix) || '.'], { timeout: gitTimeoutMs() });
    if (r.error?.code === 'ENOBUFS') fail('E_TOO_LARGE', 'search output is too large; narrow it with --node or a longer query');
    if (r.status === 1 && !r.stderr.trim()) return;
    if (r.error || r.status !== 0) unavailable(ctx.base, ctx.alias, 'search', gitError(r));
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [where, number, ...rest] = line.split('\0'), repo = where.slice(ctx.commit.length + 1), text = rest.join('\0');
      if (!repo.endsWith('.md') || (ctx.base.root !== '.' && !repo.startsWith(ctx.base.root + '/'))) continue;
      const p = basePathOf(ctx, repo);
      if (p.split('/').some(s => s.startsWith('.'))) continue;
      hits.push({ base: ctx.alias, path: p, line: Number(number), snippet: snippet(text, find(text)) });
    }
    return;
  }
  let files = 0, bytes = 0;
  const walk = dir => {
    for (const r of children(ctx, dir)) {
      const p = dir ? `${dir}/${r.name}` : r.name;
      if (r.type === 'dir') { walk(p); continue; }
      if (r.type !== 'file' || !r.name.endsWith('.md')) continue;
      const e = dirEntry(ctx, p);
      if (++files > WALK_FILES || (bytes += fs.statSync(e.file).size) > WALK_BYTES) fail('E_TOO_LARGE', `directory search is bounded to ${WALK_FILES} files / ${WALK_BYTES} bytes; narrow it with --node`);
      readBounded(e.file).split(/\r?\n/).forEach((text, i) => { const at = find(text); if (at >= 0) hits.push({ base: ctx.alias, path: p, line: i + 1, snippet: snippet(text, at) }); });
    }
  };
  walk(prefix);
}
export function search(source, flags, positionals) {
  if (!positionals.length) fail('E_USAGE', 'search needs the text to look for');
  const query = positionals.join(' ');
  if (flags.all && flags.base) fail('E_USAGE', 'choose --base ALIAS or --all');
  let node = flags.node ?? null, only = flags.base ?? null;
  if (node && node.includes('/')) { const [a, n] = splitRef(node); if (only && only !== a) fail('E_USAGE', `--base ${only} disagrees with --node ${node}`); only = a; node = n; }
  const mine = [...new Set(refsOf(source.decl).map(([ref]) => splitRef(ref)[0]))];
  const scope = only ? [only] : flags.all || !mine.length ? Object.keys(source.bindings.bases) : mine;
  if (node && scope.length !== 1) fail('E_USAGE', '--node needs one base: pass --base ALIAS or --node ALIAS/NODE');
  const hits = [], receipts = [];
  for (const alias of scope) withBase(source.bindings, alias, { fresh: !!flags.fresh }, ctx => {
    receipts.push(ctx.receipt);
    searchBase(ctx, node ? nodePath(ctx, node) : '', query, { regex: !!flags.regex, caseSensitive: !!flags['case-sensitive'] }, hits);
  });
  const shownHits = hits.slice(0, HIT_LIMIT), more = hits.length - shownHits.length;
  const text = shownHits.map(h => `${h.base}${shown(h.path)}:${h.line}: ${h.snippet}`).join('\n');
  return { result: { query, regex: !!flags.regex, bases: scope, node, hits: shownHits, total: hits.length, more, receipts: Object.fromEntries(receipts.map(r => [r.base, r])) },
    text: `${text || `no matches for ${JSON.stringify(query)}`}${more ? `\n… and ${more} more (narrow with --node or a longer query)` : ''}\n${footer(receipts)}` };
}
// ---------------------------------------------------------------- subject layout (okf 6.0)
// The verbs answer from committed generated indexes (one blob each), never
// from a scan of the base (the staleness check validates an unvalidated
// commit once: noteStale). A base without the reserved nodes answers E_USAGE.
// A version-2 soul has no nodes: a <kind>/<slug> is always a subject. A
// version-1 soul keeps alias/node precedence for a kind that is a bound alias.
const isSubjectArg = (source, p) => SUBJECT_REF.test(p) && (source.decl.version === 2 || !Object.hasOwn(source.bindings.bases, p.split('/')[0]));
function subjectArg(ref) {
  if (typeof ref !== 'string' || !SUBJECT_REF.test(ref)) fail('E_USAGE', `expected a subject <system|workstream|project>/<slug>, got ${JSON.stringify(ref ?? null)}`);
  return ref;
}
/** The layout as the validator classifies it (layoutOf, on the whole text):
 *  no okf-base.json or invalid JSON is plain; subject-layout metadata above
 *  the shared limit is refused, never plain; a plain base's metadata has no
 *  such limit (consult's own read bound, as 5.8's for every okf-base.json read). */
export function hasSubjectLayout(ctx) {
  const e = entry(ctx, 'okf-base.json');
  if (!e || e.type !== 'file') return false;
  return layoutOf(read(ctx, 'okf-base.json', e));
}
/** fn(ctx) on the base a subject verb reads: --base, the only bound base, or
 *  the only bound base with the subject layout. */
export function withLayout(source, flags, fn) {
  const aliases = Object.keys(source.bindings.bases), opts = { fresh: !!flags.fresh };
  if (flags.base || aliases.length === 1) {
    const alias = flags.base ?? aliases[0];
    return withBase(source.bindings, alias, opts, ctx => hasSubjectLayout(ctx) ? (noteStale(ctx), fn(ctx)) : fail('E_USAGE', `base ${alias} has no subject layout`));
  }
  const found = aliases.filter(alias => withBase(source.bindings, alias, opts, hasSubjectLayout));
  if (found.length > 1) fail('E_USAGE', `several bases have the subject layout (${found.join(', ')}); pass --base ALIAS`);
  if (!found.length) fail('E_USAGE', `bases ${aliases.join(', ')} have no subject layout`);
  return withBase(source.bindings, found[0], opts, ctx => (noteStale(ctx), fn(ctx)));
}
// okf 6.0: the subject verbs read the committed generated indexes as they are.
// A base whose indexes are stale is not refused: each verb warns once per base
// (stderr, and `warnings` in --json) when the base's validation says so. A
// directory base is judged now. A Git base's validation is cached per commit;
// when none is cached for the commit read (after --fresh, or a fetch that
// moved the accepted branch), the verb validates and caches it as spawn does,
// so the first read of a new commit warns. An offline context (the spawn
// brief) never fetches for it: missing objects leave the warning to the next
// read. A validation that cannot run (the base unavailable) gives no warning
// and caches nothing, so the next read tries again; the read itself goes on.
const warned = [];
export const takeWarnings = () => warned.splice(0);
function noteStale(ctx) {
  let n = 0;
  if (ctx.kind === 'directory') { try { n = validateBase(ctx.base.path, ctx.base, { reader: true }).stale; } catch { return; } }
  else {
    let v;
    try { v = verdict(ctx, { fetchMissing: !ctx.offline }); } catch { return; }
    if (v.ok) n = v.stale ?? 0;
  }
  if (n > 0) { const w = staleWarning(n, short(ctx.receipt)); if (!warned.includes(w)) warned.push(w); }
}
/** Where each subject ref lives: the one bound base with the subject layout
 *  holding its file (--base narrows the search to one). → Map ref → alias.
 *  A ref in two bases is ambiguous (E_USAGE, pass --base). */
function subjectBases(source, flags, refs) {
  const aliases = flags.base ? [flags.base] : Object.keys(source.bindings.bases), layouts = [];
  const found = new Map(refs.map(ref => [ref, []]));
  for (const alias of aliases) withBase(source.bindings, alias, { fresh: !!flags.fresh }, ctx => {
    if (!hasSubjectLayout(ctx)) return;
    layouts.push(alias);
    for (const ref of refs) if (entry(ctx, subjectFile(ref))?.type === 'file') found.get(ref).push(alias);
  });
  if (!layouts.length) fail('E_USAGE', aliases.length === 1 ? `base ${aliases[0]} has no subject layout` : `bases ${aliases.join(', ')} have no subject layout`);
  for (const [ref, at] of found) {
    if (at.length > 1) fail('E_USAGE', `subject ${ref} is in several bases (${at.join(', ')}); pass --base ALIAS`);
    if (!at.length) fail('E_NOT_FOUND', `no bound base with the subject layout (${layouts.join(', ')}) has subject ${ref} (/${subjectFile(ref)}); \`oats okf subjects\` lists them`);
  }
  return new Map([...found].map(([ref, at]) => [ref, at[0]]));
}
/** fn(ctx) on the base holding one subject. */
const withSubject = (source, flags, ref, fn) => withBase(source.bindings, subjectBases(source, flags, [ref]).get(ref), {}, fn);
function subjectEntry(ctx, ref) {
  const file = subjectFile(ref), e = entry(ctx, file);
  if (!e || e.type !== 'file') fail('E_NOT_FOUND', `${ctx.alias} has no subject ${ref} (${shown(file)}) at ${short(ctx.receipt)}; \`oats okf subjects\` lists them`);
  return { file, e };
}
function readView(ctx, ref) {
  noteStale(ctx);
  subjectEntry(ctx, ref);
  const path = viewFile(ref), e = entry(ctx, path);
  if (!e || e.type !== 'file') fail('E_NOT_FOUND', `${ctx.alias}${shown(path)}: subject ${ref} has no generated index at ${short(ctx.receipt)}; the base's maintainer runs okf-reindex.mjs`);
  const text = read(ctx, path, e);
  return { path, text, view: parseView(text) };
}
const plural = (type, n) => { const t = type.toLowerCase(); return n === 1 ? t : /(s|x|ch|sh)$/.test(t) ? `${t}es` : /[^aeiou]y$/.test(t) ? `${t.slice(0, -1)}ies` : `${t}s`; };
export const countText = counts => [...counts].map(([type, n]) => `${n} ${plural(type, n)}`).join(', ');
/** A view's claim counts by type, for display: a type over HEADING_CHARS is
 *  cut (types that then read alike are counted together), so the answer and
 *  its JSON keys stay bounded whatever an untrusted committed index holds. */
function shownCounts(view) {
  const out = new Map();
  for (const [type, n] of viewCounts(view)) { const t = cutHeading(type); out.set(t, (out.get(t) ?? 0) + n); }
  return out;
}
function subjectIndexes(source, flags, refs) {
  refs.forEach(subjectArg);
  const declared = new Set(source.decl.subjects ?? []), where = subjectBases(source, flags, refs), byRef = new Map(), receipts = [];
  // Each subject from the base that holds it, in declaration order.
  for (const alias of [...new Set(where.values())]) withBase(source.bindings, alias, {}, ctx => {
    receipts.push(ctx.receipt);
    for (const ref of refs.filter(r => where.get(r) === alias)) { const v = readView(ctx, ref); byRef.set(ref, { base: alias, node: null, subject: ref, relation: declared.has(ref) ? 'subject' : null, path: v.path, text: v.text, receipt: ctx.receipt }); }
  });
  const indexes = refs.map(ref => byRef.get(ref));
  const text = indexes.map(x => `## ${x.base}/${x.subject}${x.relation ? ` (${x.relation})` : ''}\n\n${x.text.trimEnd()}\n`).join('\n');
  return { result: { indexes }, text: `${text}\n${footer(receipts)}` };
}
export function subjects(source, flags, positionals) {
  if (positionals.length) fail('E_USAGE', 'subjects takes no argument; filter with --kind system|workstream|project');
  if (flags.kind !== undefined && !Object.hasOwn(KINDS, flags.kind)) fail('E_USAGE', `--kind is one of ${Object.keys(KINDS).join(', ')}`);
  const declared = new Set(source.decl.subjects ?? []);
  return withLayout(source, flags, ctx => {
    const path = 'subjects/index.md';
    const rows = parseSubjectsIndex(read(ctx, path, requireFile(ctx, path))).filter(x => !flags.kind || x.kind === flags.kind).map(x => ({ ...x, declared: declared.has(x.ref) }));
    const text = rows.map(x => `${x.ref} — ${x.title}${x.description ? `: ${x.description}` : ''}`).join('\n');
    return { result: { base: ctx.alias, kind: flags.kind ?? null, subjects: rows, receipt: ctx.receipt }, text: `${text || '(no subjects)'}\n${footer([ctx.receipt])}` };
  });
}
export function subject(source, flags, positionals) {
  const ref = subjectArg(onePath(positionals, 'subject <kind>/<slug>'));
  return withSubject(source, flags, ref, ctx => {
    const { file, e } = subjectEntry(ctx, ref), text = read(ctx, file, e), meta = parseFrontmatter(text).meta ?? {};
    const list = key => Array.isArray(meta[key]) ? meta[key] : [];
    const { path, view } = readView(ctx, ref), counts = shownCounts(view);
    const members = view.members.map(m => subjectOfPath(m.path)?.ref).filter(Boolean);
    const result = { base: ctx.alias, ref, path: file, title: view.title, description: view.description, legacyNodes: list('legacy-nodes'), inWorkstreams: list('in-workstreams'), dependsOn: list('depends-on'), members, counts: Object.fromEntries(counts), index: path, text, receipt: ctx.receipt };
    const lines = [
      result.legacyNodes.length ? `legacy nodes: ${result.legacyNodes.join(', ')}` : null,
      result.inWorkstreams.length ? `in workstreams: ${result.inWorkstreams.join(', ')}` : null,
      result.dependsOn.length ? `depends on: ${result.dependsOn.join(', ')}` : null,
      members.length ? `in this workstream: ${members.join(', ')}` : null,
      `claims: ${countText(counts) || 'none yet'} (${shown(path)}; \`oats okf claims --about ${ref}\`)`
    ].filter(Boolean);
    return { result, text: `${text.trimEnd()}\n\n${lines.join('\n')}\n${footer([ctx.receipt])}` };
  });
}
const HEADING_CHARS = 200;
const cutHeading = v => v.length > HEADING_CHARS ? `${v.slice(0, HEADING_CHARS)}…` : v;
export function claims(source, flags, positionals) {
  if (positionals.length) fail('E_USAGE', 'claims takes --about <kind>/<slug> [--type T] [--kind K]');
  if (flags.about === undefined) fail('E_USAGE', 'claims needs --about <kind>/<slug>');
  const ref = subjectArg(flags.about);
  return withSubject(source, flags, ref, ctx => {
    const { path, view } = readView(ctx, ref);
    // Each row repeats its section's type and kind: those read from an
    // untrusted committed index are cut to HEADING_CHARS so a long heading
    // over many entries cannot multiply the answer (the filter sees them whole).
    // The filter is compared once per distinct type and kind (keyed by the
    // parser's textKey), not once per section: one long type over many kinds.
    const memo = (want, cache = new Map()) => (text, key) => { if (want === undefined) return true; if (!cache.has(key)) cache.set(key, (text ?? '').toLowerCase() === want); return cache.get(key); };
    // A filter is read as the index renders a heading (plain text, brackets as parentheses).
    const typeOk = memo(flags.type === undefined ? undefined : plainText(flags.type).toLowerCase()), kindOk = memo(flags.kind === undefined ? undefined : plainText(flags.kind).toLowerCase());
    const rows = view.sections.filter(x => typeOk(x.type, x.typeKey) && kindOk(x.kind, x.kindKey)).flatMap(x => {
      const type = cutHeading(x.type), kind = x.kind === null ? null : cutHeading(x.kind);
      return x.entries.map(c => ({ type, kind, title: c.title, path: c.path, description: c.description }));
    });
    const text = rows.map(r => `${shown(r.path)}  [${r.type}${r.kind ? `/${r.kind}` : ''}] ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
    return { result: { base: ctx.alias, about: ref, type: flags.type ?? null, kind: flags.kind ?? null, index: path, claims: rows, receipt: ctx.receipt }, text: `${text || '(no claims)'}\n${footer([ctx.receipt])}` };
  });
}
const CLAIM_FILE_BYTES = 1024 * 1024;
/** The verdict lanes against a base's committed verdict record (one blob for
 *  the index, one per identity hit). */
export function verdictReport(ctx, meta) {
  const path = 'verdicts/index.md', e = entry(ctx, path);
  // The generated record is required: a missing one is not "no verdicts".
  if (!e || e.type !== 'file') fail('E_NOT_FOUND', `${ctx.alias}${shown(path)}: the base has no generated verdict index at ${short(ctx.receipt)}; the base's maintainer runs okf-reindex.mjs`);
  const indexText = read(ctx, path, e);
  return verdictLanes(meta, indexText, id => { const p = `verdicts/${id}.md`, ve = entry(ctx, p); return ve && ve.type === 'file' ? read(ctx, p, ve) : null; });
}
export function verdicts(source, flags, positionals) {
  // `--check FILE`: a value flag, or (where --check is a boolean switch, as for propose) the switch and one argument.
  const file = typeof flags.check === 'string' && !positionals.length ? flags.check : flags.check === true && positionals.length === 1 ? positionals[0] : null;
  if (!file) fail('E_USAGE', 'verdicts --check <claim file>');
  let text;
  try { const stat = fs.statSync(file); if (!stat.isFile() || stat.size > CLAIM_FILE_BYTES) throw Object.assign(new Error('not a regular file under 1 MiB'), { code: 'E_SIZE' }); text = fs.readFileSync(file, 'utf8'); }
  catch (e) { fail('E_USAGE', `cannot read claim file ${file}: ${e.code || e.message}`); }
  const fm = parseFrontmatter(text);
  if (!fm.parsed) fail('E_USAGE', `${file}: no parseable frontmatter`);
  return withLayout(source, flags, ctx => {
    const report = { claim: file, base: ctx.alias, ...verdictReport(ctx, fm.meta), receipt: ctx.receipt };
    if (report.refusal) throw Object.assign(new Error(report.refusal), { code: 'E_VERDICT', result: report });
    const lines = [
      report.identity ? `identity: ${report.identity.id} ${report.identity.verdict}${report.identity.reconsidered ? ' (reconsidered by this claim)' : ''}${report.identity.reason ? ` — ${report.identity.reason}` : ''}` : `identity: ${report.id ? `${report.id} has no verdict` : 'the claim names no id'}`,
      report.candidates.length ? `title hash ${report.titleHash}: ${report.candidates.length} candidate(s) for the PR body:\n${report.candidates.map(c => `  ${c.id} ${c.verdict} [${c.claimType}] ${c.title} (${shown(c.path)})`).join('\n')}` : `title hash ${report.titleHash}: no verdict with this title`
    ];
    return { result: report, text: `${lines.join('\n')}\n${footer([ctx.receipt])}` };
  });
}
/** okf 6.0 spawn brief: one line per declared subject, from its generated
 *  index in an already-validated base (never a fetch at spawn); at most eight. */
export function subjectBriefLines(bindings, decl, accepted) {
  const lines = [];
  for (const ref of decl.subjects.slice(0, 8)) {
    const alias = Object.keys(accepted).find(a => Array.isArray(accepted[a]?.subjects) && accepted[a].subjects.includes(ref));
    let line = ref;
    if (alias) try {
      line = withBase(bindings, alias, { preferCached: true }, ctx => {
        const { view } = readView(ctx, ref), counts = countText(shownCounts(view));
        return `${ref} — ${view.description || view.title}${counts ? ` (${counts})` : ' (no claims yet)'}`;
      });
    } catch { /* the bare ref; consult reads it later */ }
    lines.push(line);
  }
  return decl.subjects.length > 8 ? [...lines.slice(0, 7), `… and ${decl.subjects.length - 7} more subjects: \`oats okf index\``] : lines;
}
export const CONSULT = { bases, index, cat, ls, links, search, subjects, subject, claims, verdicts };
