// Private same-volume scratch for synchronous capture/receipt work. These
// per-call allocations are never transferred to subprocesses. Cleanup reclaims only proven
// dead local owners; an incomplete marker or reused PID remains conservative.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { makePrivateDir } from "./private-files.mjs";

const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameObject(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function directory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`capture scratch is not a real directory: ${path}`);
  return stat;
}
function privateRoot(root, create) {
  const path = join(root, ".capture-tmp");
  if (create) { makePrivateDir(root); try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
  const stat = directory(path);
  if (stat.dev !== statSync(root, { bigint: true }).dev) throw new Error(`capture scratch must be on the record root volume: ${path}`);
  if ((stat.mode & 0o077n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid()))) throw new Error(`capture scratch directory must be private and owned by this user: ${path}`);
  return { path, stat };
}
// Bound the read, refuse links/special files before opening, and bind bytes to
// the descriptor and unchanged named file. Missing/unreadable means unknown.
function marker(dir) {
  const path = join(dir, "owner.json"); let fd;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || !sameFile(before, stat)) return null;
    const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) return null; offset += n; }
    if (!sameFile(stat, fstatSync(fd, { bigint: true })) || !sameFile(stat, lstatSync(path, { bigint: true }))) return null;
    const raw = bytes.toString("utf8"); return { stat, raw, value: JSON.parse(raw) };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function sameMarker(a, b) { return a && b && sameFile(a.stat, b.stat) && a.raw === b.raw; }
function unchanged(dir, stat, owner) {
  try { return sameObject(stat, directory(dir)) && sameMarker(owner, marker(dir)); }
  catch { return false; }
}
function localLiveness(pid) {
  try { process.kill(pid, 0); return "alive"; }
  catch (err) { return err.code === "ESRCH" ? "dead" : "unknown"; }
}

export function createCaptureScratch(root, kind) {
  if (!root || !["snapshot", "receipt"].includes(kind)) throw new Error("capture scratch requires a record root and recognized purpose");
  const base = privateRoot(root, true);
  const path = mkdtempSync(join(base.path, `${kind}-`)), stat = directory(path);
  const owner = { v: 1, kind, pid: process.pid, host: hostname(), nonce: randomBytes(16).toString("hex") };
  try {
    writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    const published = marker(path);
    if (!published || !sameObject(base.stat, directory(base.path))) throw new Error("capture scratch ownership publication failed");
    return { path, close() {
      // Ordinary callers remove only their own unchanged allocation. An
      // external replacement is preserved, even if its pathname is familiar.
      if (sameObject(base.stat, directory(base.path)) && unchanged(path, stat, published)) rmSync(path, { recursive: true });
    } };
  } catch (err) {
    // No payload has been opened yet. A partial/unreadable owner marker is
    // deliberately preserved; only an empty or positively owned allocation
    // can be removed. An empty-dir removal cannot erase substituted contents.
    try {
      if (sameObject(base.stat, directory(base.path)) && sameObject(stat, directory(path))) {
        const current = marker(path);
        if (current?.value?.nonce === owner.nonce) rmSync(path, { recursive: true });
        else rmdirSync(path);
      }
    } catch { /* uncertain ownership remains for conservative operator recovery */ }
    throw err;
  }
}

export function cleanupCaptureScratch(root, lock, { liveness = localLiveness } = {}) {
  const lockPath = join(root, ".capture.lock"), lockStat = directory(lockPath), owner = marker(lockPath);
  if (lock?.path !== lockPath || lock.held || typeof lock.release !== "function" ||
      owner?.value?.pid !== process.pid || owner.value.host !== hostname() || typeof owner.value.nonce !== "string") {
    throw new Error("capture scratch cleanup requires the current process's capture lock");
  }
  let base;
  try { base = privateRoot(root, false); } catch (err) { if (err.code === "ENOENT") return 0; throw err; }
  const entries = opendirSync(base.path); let removed = 0;
  try {
    for (let entry; (entry = entries.readSync()) !== null;) {
      const match = /^(snapshot|receipt|recovery)-[A-Za-z0-9]{6}$/.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      // Retained command jobs cross worker lifetimes intentionally. This
      // ordinary scavenger has no durable job reference and therefore cannot
      // authorize removal, even when the previous allocator is proven dead.
      if (match[1] === "recovery") continue;
      const path = join(base.path, entry.name); let stat;
      try { stat = directory(path); } catch { continue; }
      const candidate = marker(path), value = candidate?.value;
      if (value?.v !== 1 || value.kind !== match[1] || value.host !== hostname() ||
          !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 ||
          typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce)) continue;
      let live;
      try { live = liveness(value.pid); } catch { continue; }
      if (live !== "dead") continue;
      if (!unchanged(lockPath, lockStat, owner)) throw new Error("capture lock changed during scratch cleanup");
      if (!sameObject(base.stat, directory(base.path))) throw new Error("capture scratch root changed during cleanup");
      if (!unchanged(path, stat, candidate)) continue;
      // No supported user of this helper transfers scratch/FD ownership to a
      // subprocess. Dead allocator + unchanged identity is therefore required.
      rmSync(path, { recursive: true }); removed++;
    }
  } finally { entries.closeSync(); }
  return removed;
}

// Package-private filesystem checks shared with retained command allocations.
// They do not grant adoption or cleanup authority on their own.
export { privateRoot as captureScratchRoot, directory as captureScratchDirectory,
  marker as readCaptureScratchMarker, sameMarker as sameCaptureScratchMarker };
