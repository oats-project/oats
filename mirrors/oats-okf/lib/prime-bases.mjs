import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fs, join, dirname, withLock } from './io.mjs';
import { withBase, verdict, cacheDir, cacheLock, clearDeadCacheLock } from './consult.mjs';
import { resolveNodes } from './config.mjs';

const WORKER_TIMEOUT_MS = 20000;
const OUTPUT_LIMIT = 64 * 1024;
const script = fileURLToPath(import.meta.url);
const firstLine = text => String(text || 'unknown error').split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'unknown error';

export function cleanupTempCacheDirs(bindings, alias) {
  const base = bindings.bases[alias];
  if (!base || base.kind !== 'git') return;
  const dir = dirname(cacheDir(bindings, base)), lock = cacheLock(bindings, base);
  if (!fs.existsSync(dir)) return;
  clearDeadCacheLock(lock);
  try {
    withLock(lock, () => {
      const prefix = `.${base.id}.git.tmp-`;
      for (const entry of fs.readdirSync(dir)) if (entry.startsWith(prefix)) fs.rmSync(join(dir, entry), { recursive: true, force: true });
    }, { waitMs: 0 });
  } catch (error) { if (error.code !== 'E_LOCKED') throw error; }
}

function killGroup(child, signal = 'SIGKILL') {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

export function runWorker(bindings, alias, refs = null, decl = null, refreshDue = false) {
  const read = ctx => {
    const v = verdict(ctx, { fetchMissing: !ctx.offline }), wanted = Array.isArray(refs?.[alias]) ? refs[alias] : null;
    const nodes = v.ok ? Object.fromEntries((wanted || []).filter(node => Object.hasOwn(v.nodes, node)).map(node => [node, v.nodes[node]])) : v.nodes;
    return v.ok
      ? { alias, primed: true, ok: true, receipt: ctx.receipt, digest: v.digest, nodes, subjects: v.subjects ?? null, stale: v.stale ?? 0, unstamped: v.unstamped ?? 0 }
      : { alias, primed: true, ok: false, receipt: ctx.receipt, error: v.error };
  };
  return withBase(bindings, alias, { preferCached: true }, ctx => {
    const cached = read(ctx);
    // okf 6.0: a version-2 declaration resolves across bases, so one worker
    // cannot judge it; the caller primes again with refreshDue when it fails.
    if (ctx.offline && ctx.refreshDue && refreshDue) return withBase(bindings, alias, {}, read);
    if (cached.ok && ctx.offline && ctx.refreshDue && decl && decl.version !== 2) {
      const here = ref => ref.startsWith(`${alias}/`);
      try {
        resolveNodes({ ...decl, owns: decl.owns.filter(here), reads: decl.reads.filter(here) }, bindings, { [alias]: cached });
      } catch (error) {
        if (!['E_CONFIG', 'E_OWNER'].includes(error.code)) throw error;
        // A node/owner may have changed upstream since this cache was fetched.
        // Retry normal resolution once, inside this same worker's deadline.
        // Do not force --fresh: recheck TTL/attemptedAt under the cache lock.
        return withBase(bindings, alias, {}, read);
      }
    }
    return cached;
  });
}

export function runSupervisor({ bindings, aliases, refs = null, decl = null, refreshDue = false, timeoutMs = WORKER_TIMEOUT_MS }) {
  const children = new Set();
  const stopAll = () => { for (const child of children) killGroup(child); };
  process.once('SIGTERM', () => { stopAll(); process.exit(143); });
  process.once('SIGINT', () => { stopAll(); process.exit(130); });
  process.once('exit', stopAll);

  const run = alias => new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, tooLarge = false, done = false;
    const child = spawn(process.execPath, [script, '--worker'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    children.add(child);
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); children.delete(child); cleanupTempCacheDirs(bindings, alias); resolve(result);
    };
    const tooMuch = () => { tooLarge = true; killGroup(child); };
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    child.stdin.end(JSON.stringify({ bindings, alias, refs, decl, refreshDue }));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > OUTPUT_LIMIT) tooMuch(); else stdout += chunk; });
    child.stderr.on('data', chunk => { if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > OUTPUT_LIMIT) tooMuch(); else stderr += chunk; });
    child.on('error', error => finish({ alias, reason: error.message }));
    child.on('close', status => {
      if (timedOut) return finish({ alias, reason: 'timed out' });
      if (tooLarge) return finish({ alias, reason: 'priming output exceeded 64 KiB' });
      if (status !== 0) return finish({ alias, reason: firstLine(stderr || `prime exited ${status}`) });
      try { finish(JSON.parse(stdout || '{}')); }
      catch { finish({ alias, reason: 'invalid priming result' }); }
    });
  });
  return Promise.all(aliases.map(run));
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (process.argv[2] === '--worker') {
    try { process.stdout.write(JSON.stringify(runWorker(payload.bindings, payload.alias, payload.refs, payload.decl, !!payload.refreshDue))); }
    catch (error) { console.error(firstLine(error?.message)); process.exit(1); }
    return;
  }
  const rows = await runSupervisor(payload);
  process.stdout.write(JSON.stringify(rows));
}

if (process.argv[1] === script) main().catch(error => { console.error(firstLine(error?.message)); process.exit(1); });
