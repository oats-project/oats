// The backend's request checks: the per-launch credential every request carries, where it comes
// from at startup, and the private directory the server's socket lives in. Zero-dependency and
// importable, so the startup refusals and the bearer comparison are tested on their own as well as
// through the real server (server/oats-web.mjs).
//
// The credential is 32 random bytes, base64url without padding: exactly 43 characters. Main makes
// a fresh one for each server child and hands it over the child's fd 3 (`--token-fd 3`); a server
// started by hand reads it from a file of the operator's own (`--token-file <path>`). It is never
// on argv, in the environment, or in any output.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";

/** 32 bytes, base64url, no padding. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Never read more than this from fd 3 or a token file. */
export const SECRET_READ_LIMIT = 4096;
/** The one answer to a request without the credential. */
export const UNAUTHORIZED = Object.freeze({ error: "unauthorized", code: "E_UNAUTHORIZED" });

/** A startup refusal: `message` names the flag, never a value read from it. */
export class StartupRefusal extends Error {}
const refuse = (message) => { throw new StartupRefusal(message); };

/** The credential in `raw` (one trailing newline trimmed), or null when it is not exactly 43 base64url characters. */
export function parseSecret(raw) {
  const text = String(raw).replace(/\r?\n$/, "");
  return SECRET_PATTERN.test(text) ? text : null;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Read `fd` to EOF, synchronously and bounded, then close it. Throws StartupRefusal (`flag` named). */
export function readSecretFd(fd, { flag = "--token-fd", fs = { readSync, closeSync }, waitMs = 10_000 } = {}) {
  const chunks = []; let size = 0;
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const buf = Buffer.alloc(SECRET_READ_LIMIT + 1 - size);
      let n;
      try { n = fs.readSync(fd, buf, 0, buf.length, null); }
      catch (e) {
        if (e?.code === "EAGAIN" && Date.now() < deadline) { sleep(10); continue; }
        refuse(`${flag}: cannot read the credential from that descriptor`);
      }
      if (n === 0) break;
      chunks.push(buf.subarray(0, n)); size += n;
      if (size > SECRET_READ_LIMIT) refuse(`${flag}: the credential is too long`);
    }
  } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
  const secret = parseSecret(Buffer.concat(chunks).toString("utf8"));
  if (!secret) refuse(`${flag}: the credential must be exactly 43 base64url characters`);
  return secret;
}

/** Read a token file: opened once without following a link (and without waiting on a FIFO), checked on
 * that descriptor (a regular file owned by this uid with no group/other bits), read bounded, closed.
 * Returns `{ secret, identity: { dev, ino } }`, the identity being the file's, so nothing ever serves it.
 * Throws StartupRefusal. */
export function readSecretFile(path, { flag = "--token-file", uid = process.getuid?.(),
  fs = { openSync, fstatSync, readSync, closeSync } } = {}) {
  let fd;
  // O_NONBLOCK: a FIFO opens at once (and is refused below) instead of waiting for a writer.
  try { fd = fs.openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0)); }
  catch { refuse(`${flag}: cannot open the token file (it must be a regular file, not a link)`); }
  let st;
  try {
    try { st = fs.fstatSync(fd); } catch { refuse(`${flag}: cannot inspect the token file`); }
    if (!st.isFile()) refuse(`${flag}: the token file must be a regular file`);
    if (uid !== undefined && st.uid !== uid) refuse(`${flag}: the token file must be owned by this user`);
    if ((st.mode & 0o077) !== 0) refuse(`${flag}: the token file must not be readable or writable by group or others (chmod 600)`);
  } catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } throw e; }
  return { secret: readSecretFd(fd, { flag, fs, waitMs: 0 }), identity: { dev: st.dev, ino: st.ino } };
}

/** Whether a stat result is the file `identity` names (a token file): such a file is never served. */
export const sameFile = (st, identity) => !!identity && !!st && st.dev === identity.dev && st.ino === identity.ino;

/** Refuse a socket path whose parent is not a real directory (lstat: not a link) owned by this uid
 * with no group/other bits. Returns the parent. Throws StartupRefusal (`--socket` named). */
export function checkSocketParent(socketPath, { uid = process.getuid?.(), fs = { lstatSync } } = {}) {
  if (typeof socketPath !== "string" || !socketPath.startsWith("/")) refuse("--socket: the socket path must be absolute");
  const parent = dirname(socketPath);
  let st;
  try { st = fs.lstatSync(parent); } catch { refuse("--socket: the socket's directory does not exist"); }
  if (!st.isDirectory()) refuse("--socket: the socket's directory must be a real directory, not a link");
  if (uid !== undefined && st.uid !== uid) refuse("--socket: the socket's directory must be owned by this user");
  if ((st.mode & 0o077) !== 0) refuse("--socket: the socket's directory must have no group or other permissions (chmod 700)");
  return parent;
}

/** `Bearer <secret>`, as the bytes a request's Authorization header is compared with. */
export const bearerBytes = (secret) => Buffer.from(`Bearer ${secret}`, "utf8");

/** Whether an Authorization header value is exactly `expected` (bearerBytes): a constant-time
 * comparison, and a length mismatch refused without comparing. Anything but one string refuses. */
export function bearerMatches(header, expected) {
  if (typeof header !== "string" || !Buffer.isBuffer(expected)) return false;
  const given = Buffer.from(header, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
