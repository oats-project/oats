// Where main puts its server's socket: one private directory per server generation.
//
// The base does not depend on the user name or the home's depth: on Linux `$XDG_RUNTIME_DIR` when
// it is a real directory owned by this uid with no group/other bits, else the system temp
// directory; on macOS (and elsewhere) the system temp directory (macOS's per-user
// /var/folders/…/T/). The directory is `mkdtemp(<base>/oats-d-XXXXXX)`, checked after creation
// (a real directory, owned by this uid, no group/other bits), and the socket is `<dir>/s`. A
// socket path over 103 bytes (macOS's sun_path is 104 with its NUL) is refused before anything
// starts: there is no TCP fallback.
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

export const SOCKET_DIR_PREFIX = "oats-d-";
export const SOCKET_NAME = "s";
/** The longest socket path main starts a server on, in bytes, on every platform. */
export const SOCKET_PATH_LIMIT = 103;

const privateDirectory = (st, uid) => st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0;

/**
 * The base directory of the socket directories. `home` and `user` are accepted and never used: the
 * path's length must not depend on them.
 */
export function socketBase({ platform = process.platform, env = process.env, uid = process.getuid?.(), tmpdir = osTmpdir, fs = { lstatSync } } = {}) {
  if (platform === "linux" && typeof env.XDG_RUNTIME_DIR === "string" && env.XDG_RUNTIME_DIR.startsWith("/")) {
    try { if (privateDirectory(fs.lstatSync(env.XDG_RUNTIME_DIR), uid)) return env.XDG_RUNTIME_DIR; } catch { /* not there */ }
  }
  return tmpdir();
}

/** The socket path's length against the limit. */
export function socketPathFits(socketPath) {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  return { ok: bytes <= SOCKET_PATH_LIMIT, bytes, limit: SOCKET_PATH_LIMIT };
}

/** A refusal naming the path, its length and the limit. */
export class SocketPathTooLong extends Error {
  constructor(socketPath, bytes) {
    super(`the backend server's socket path is ${bytes} bytes, over the limit of ${SOCKET_PATH_LIMIT}: ${socketPath} (set TMPDIR to a shorter directory)`);
    this.name = "SocketPathTooLong"; this.code = "E_SOCKET_PATH_TOO_LONG"; this.socketPath = socketPath; this.bytes = bytes;
  }
}

/**
 * Make one generation's private directory under `base`. Returns `{ dir, socketPath, remove() }`;
 * throws SocketPathTooLong (the directory removed again) or when the made directory is not private.
 */
export function makeSocketDir(base, { uid = process.getuid?.(), fs = { mkdtempSync, lstatSync, rmSync } } = {}) {
  // The length is known before anything is made: mkdtemp adds six characters.
  const planned = join(base, `${SOCKET_DIR_PREFIX}XXXXXX`, SOCKET_NAME);
  const fit = socketPathFits(planned);
  if (!fit.ok) throw new SocketPathTooLong(planned, fit.bytes);
  const dir = fs.mkdtempSync(join(base, SOCKET_DIR_PREFIX));
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { remove(); throw e; }
  if (!privateDirectory(st, uid)) { remove(); throw new Error("the backend server's socket directory is not private to this user"); }
  const socketPath = join(dir, SOCKET_NAME);
  const again = socketPathFits(socketPath);
  if (!again.ok) { remove(); throw new SocketPathTooLong(socketPath, again.bytes); }
  return { dir, socketPath, remove };
}

/** Whether something accepts a connection on the socket at `path`. */
function socketAnswers(path) {
  return new Promise((done) => {
    const c = createConnection({ path });
    const end = (answers) => { c.destroy(); done(answers); };
    c.once("connect", () => end(true));
    c.once("error", (e) => end(e?.code !== "ECONNREFUSED" && e?.code !== "ENOENT"));
    c.setTimeout(1000, () => end(true));
  });
}

/**
 * Sweep the socket directories a crashed Desktop left under `base`: only a directory of ours by
 * name, owned by this uid, private, holding nothing but our socket, and that socket answering no
 * one (a live server of another Desktop of this user is left alone). Best effort; resolves the
 * directories removed.
 */
export async function sweepStaleSocketDirs(base, { uid = process.getuid?.(), fs = { readdirSync, lstatSync, rmSync }, answers = socketAnswers } = {}) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(base); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(SOCKET_DIR_PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (!privateDirectory(fs.lstatSync(dir), uid)) continue;
      const inside = fs.readdirSync(dir);
      if (inside.length > 1 || (inside.length === 1 && inside[0] !== SOCKET_NAME)) continue;
      if (inside.length === 1) {
        const socket = join(dir, SOCKET_NAME), st = fs.lstatSync(socket);
        if (!st.isSocket() || (uid !== undefined && st.uid !== uid)) continue;
        if (await answers(socket)) continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* gone, or not ours to judge */ }
  }
  return removed;
}
