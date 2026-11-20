// Private command allocations survive worker lifetimes deliberately. A durable
// job reference plus allocation/file identities is required; names alone never
// authorize adoption, proof or deletion. Public per-call scratch stays separate.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { captureContext } from "./capture-context.mjs";
import { readCaptureLockOwner } from "./capture-lock.mjs";
import { holderLiveness } from "./lock-holder.mjs";
import { captureScratchRoot, captureScratchDirectory, readCaptureScratchMarker,
  sameCaptureScratchMarker } from "./capture-scratch.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = marker => ({ identity: identity(marker.stat), hash: hash(marker.raw) });
const validIdentity = value => value && ["dev", "ino"].every(k => typeof value[k] === "string" && /^\d+$/.test(value[k]));
const validStamp = value => value && validIdentity(value.identity) && /^[a-f0-9]{64}$/.test(value.hash);

function worker(root, start) {
  const owner = readCaptureLockOwner(root);
  if (!process.connected || start?.root !== root || start.parent?.pid !== process.ppid ||
      owner?.pid !== process.ppid || owner.host !== hostname() || owner.nonce !== start.parent.nonce ||
      owner.worker?.pid !== process.pid || owner.worker.host !== hostname() || owner.worker.nonce !== start.workerNonce) {
    throw new Error("retained capture scratch requires the registered root-lock worker");
  }
}
function context(store, stream, start) {
  worker(store.root, start);
  const current = captureContext(store);
  if (!current?.state.depth || !current.held.has(stream)) throw new Error("retained capture scratch requires its stream work group");
  return current.state;
}
function claimFor(state, key) {
  const claim = state.get("recovery-allocation", key);
  if (claim === null) return null;
  if (claim.v !== 1 || typeof claim.stream !== "string" || !claim.stream ||
      !/^recovery-[A-Za-z0-9]{6}$/.test(claim.name) || !/^[a-f0-9]{32}$/.test(claim.id) ||
      ![claim.base, claim.directory, claim.payload].every(validIdentity) || !validStamp(claim.owner) ||
      !["active", "deleting"].includes(claim.phase)) throw new Error("invalid retained capture job reference");
  return claim;
}
function location(root, claim) {
  const base = captureScratchRoot(root, false), path = join(base.path, claim.name);
  if (!equal(identity(base.stat), claim.base) || !equal(identity(captureScratchDirectory(path)), claim.directory)) {
    throw new Error("retained capture allocation identity changed");
  }
  return { base, path };
}
function ownerAt(path, key, claim) {
  const marker = readCaptureScratchMarker(path), value = marker?.value;
  if (!marker || value.v !== 2 || value.kind !== "recovery" || value.allocation !== claim.id || value.job !== hash(key) ||
      value.host !== hostname() || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 ||
      !/^[a-f0-9]{32}$/.test(value.nonce) || !validIdentity(value.publication) ||
      !equal(value.publication, identity(marker.stat)) ||
      !(equal(stamp(marker), claim.owner) || validStamp(value.previous) && equal(value.previous, claim.owner))) {
    throw new Error("retained capture owner differs from its durable reference");
  }
  return marker;
}
function payloadAt(path, claim, { allowMissing = false } = {}) {
  try {
    const stat = lstatSync(join(path, "payload"), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !equal(identity(stat), claim.payload) ||
        (stat.mode & 0o077n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
      throw new Error("retained capture payload identity or privacy changed");
    }
    return stat;
  } catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
}
function assertReference(root, state, key, claim, path, marker, start) {
  worker(root, start);
  if (!equal(claimFor(state, key), claim) || location(root, claim).path !== path ||
      !sameCaptureScratchMarker(marker, readCaptureScratchMarker(path))) throw new Error("retained capture reference changed");
}
function publish(path, data, check) {
  const temporary = join(path, `.owner-${randomBytes(16).toString("hex")}.tmp`);
  let fd, dir, made, renamed = false;
  try {
    dir = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    fd = openSync(temporary, "wx", 0o600); made = identity(fstatSync(fd));
    // The self identity distinguishes this publication from copied/replaced
    // bytes, even in the crash window before its stamp reaches the DB.
    writeFileSync(fd, JSON.stringify({ ...data, publication: made })); fsyncSync(fd);
    check();
    if (!equal(identity(lstatSync(temporary)), made)) throw new Error("retained capture owner publication changed");
    renameSync(temporary, join(path, "owner.json")); renamed = true; fsyncSync(dir);
    const marker = readCaptureScratchMarker(path);
    if (!marker || !equal(identity(marker.stat), made)) throw new Error("retained capture owner publication failed");
    return marker;
  } finally {
    if (!renamed && made) {
      try { if (equal(identity(lstatSync(temporary)), made)) unlinkSync(temporary); } catch { /* uncertain files remain */ }
    }
    if (fd !== undefined) closeSync(fd); if (dir !== undefined) closeSync(dir);
  }
}
function ownerValue(key, id, start, previous) {
  return { v: 2, kind: "recovery", allocation: id, job: hash(key), host: hostname(), pid: process.pid,
    nonce: start.workerNonce, ...(previous ? { previous } : {}) };
}
function handle(root, state, key, claim, path, marker, start, fd) {
  let closed = false;
  return { path, claim, fd,
    verify() {
      if (closed) throw new Error("retained capture allocation is closed");
      assertReference(root, state, key, claim, path, marker, start);
      const named = payloadAt(path, claim, { allowMissing: claim.phase === "deleting" });
      if (fd !== null && (!named || !equal(identity(fstatSync(fd)), claim.payload))) throw new Error("retained capture descriptor changed");
    },
    close() { if (!closed && fd !== null) closeSync(fd); closed = true; },
  };
}

export function createRetainedCaptureScratch(store, stream, key, start) {
  const state = context(store, stream, start);
  if (typeof key !== "string" || !key || claimFor(state, key)) throw new Error("retained capture job already exists or is invalid");
  const base = captureScratchRoot(store.root, true), path = mkdtempSync(join(base.path, "recovery-"));
  const directory = identity(captureScratchDirectory(path)), id = randomBytes(16).toString("hex");
  let fd, parent, rootFd;
  try {
    fd = openSync(join(path, "payload"), "wx+", 0o600); fsyncSync(fd);
    const marker = publish(path, ownerValue(key, id, start), () => {
      worker(store.root, start);
      if (!equal(identity(captureScratchDirectory(path)), directory) ||
          !equal(identity(captureScratchRoot(store.root, false).stat), identity(base.stat))) throw new Error("retained capture allocation changed before publication");
    });
    parent = openSync(base.path, constants.O_RDONLY | constants.O_NOFOLLOW); fsyncSync(parent);
    rootFd = openSync(store.root, "r"); fsyncSync(rootFd);
    const claim = { v: 1, stream, id, name: path.slice(base.path.length + 1), base: identity(base.stat),
      directory, payload: identity(fstatSync(fd)), owner: stamp(marker), phase: "active" };
    payloadAt(path, claim);
    state.set("recovery-allocation", key, claim);
    return handle(store.root, state, key, claim, path, marker, start, fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    // A killed/uncommitted creation has no durable reference. It is not safe
    // to infer cleanup authority later merely from its pathname or age.
    throw error;
  } finally { if (parent !== undefined) closeSync(parent); if (rootFd !== undefined) closeSync(rootFd); }
}

export function openRetainedCaptureScratch(store, stream, key, start, { cleanup = false, liveness = holderLiveness } = {}) {
  const state = context(store, stream, start); let claim = claimFor(state, key);
  if (!claim || claim.stream !== stream) throw new Error("retained capture job reference is missing or belongs to another stream");
  const { path } = location(store.root, claim); let marker = ownerAt(path, key, claim), fd = null;
  const payload = payloadAt(path, claim, { allowMissing: cleanup || claim.phase === "deleting" });
  if (payload) {
    fd = openSync(join(path, "payload"), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!equal(identity(fstatSync(fd)), claim.payload)) { closeSync(fd); throw new Error("retained capture payload changed during open"); }
  }
  try {
    const mine = marker.value.pid === process.pid && marker.value.nonce === start.workerNonce;
    if (!mine) {
      if (liveness(marker.value) !== "dead") throw new Error("retained capture owner is not proven dead");
      marker = publish(path, ownerValue(key, claim.id, start, claim.owner), () => {
        assertReference(store.root, state, key, claim, path, marker, start);
        payloadAt(path, claim, { allowMissing: cleanup || claim.phase === "deleting" });
        if (liveness(marker.value) !== "dead") throw new Error("retained capture owner death became uncertain");
      });
    }
    // Publication may precede this transaction's commit. A successor accepts
    // the self-identified publication's previous stamp, never an arbitrary
    // replacement marker, then publishes its own lease after death proof.
    claim = { ...claim, owner: stamp(marker), ...(cleanup ? { phase: "deleting" } : {}) };
    state.set("recovery-allocation", key, claim);
    return handle(store.root, state, key, claim, path, marker, start, fd);
  } catch (error) { if (fd !== null) closeSync(fd); throw error; }
}

// Resume deletion after either side of its filesystem/DB boundary. Once the
// exact allocation is gone, there is no owner marker to adopt. Only an already
// committed deleting claim in the unchanged scratch base qualifies absence;
// a missing owner/payload inside an extant directory is still uncertain.
export function prepareRetainedCaptureCleanup(store, stream, key, start) {
  const state = context(store, stream, start), claim = claimFor(state, key);
  if (!claim || claim.stream !== stream) throw new Error("retained cleanup reference is missing or differs");
  try { location(store.root, claim); }
  catch (error) {
    if (error.code !== "ENOENT" || claim.phase !== "deleting" ||
        !equal(identity(captureScratchRoot(store.root, false).stat), claim.base)) throw error;
    return;
  }
  openRetainedCaptureScratch(store, stream, key, start, { cleanup: true }).close();
}

// Mark deletion through open(..., {cleanup:true}), COMMIT that group, then
// remove outside a DB transaction. The caller can finalize many removed job
// references in one later transaction. A crash at either boundary is repeatable.
export function removeRetainedCaptureScratch(root, state, key, start) {
  worker(root, start);
  if (state.depth) throw new Error("retained capture cleanup needs a committed deletion mark");
  const claim = claimFor(state, key);
  if (!claim || claim.phase !== "deleting") throw new Error("retained capture cleanup lacks a durable deletion mark");
  let where;
  try { where = location(root, claim); }
  catch (error) {
    if (error.code === "ENOENT") {
      // Absence is completion only for the exact referenced allocation. A
      // replaced scratch base must still refuse even if this child is absent.
      if (!equal(identity(captureScratchRoot(root, false).stat), claim.base)) throw error;
      return true;
    }
    throw error;
  }
  const { path } = where, marker = ownerAt(path, key, claim);
  if (marker.value.pid !== process.pid || marker.value.nonce !== start.workerNonce) throw new Error("retained capture cleanup requires adoption by this worker");
  payloadAt(path, claim, { allowMissing: true });
  assertReference(root, state, key, claim, path, marker, start);
  rmSync(path, { recursive: true });
  return true;
}
