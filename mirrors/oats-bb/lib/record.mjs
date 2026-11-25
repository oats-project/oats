// The provider's own record of the bb threads it made for a home (contract r32, A17(1)(b)).
//
// A retire deletes the home's bb environment only where every thread on it is one this
// provider made for this home (lib/stop.mjs). bb keeps one environment per home, shared by
// every thread that runs there, a person's included, and nothing bb shows tells the two
// apart. So each launch notes the thread it made here, and the retire hook reads it.
//
// - Where: `$XDG_STATE_HOME/oats-bb/homes/` (`~/.local/state/oats-bb/homes/` where that
//   is unset or not an absolute path, on macOS too), on this host, for the OS user the
//   provider and bb run as. Outside every home, and outside the kernel's
//   `.oats-retirement/`. Directories 0700, files 0600.
// - What: one file per home, named by a hash of the home's real path. Its first line is
//   the home directory's identity (device, inode, birth time); every other line is one
//   thread id. Nothing else: no title, nothing of a person's, no secret, and not the path.
// - Which home: the real path AND the directory's identity, by the rule below (sameHome).
//   A home made again at the same path is another directory: an earlier one's record
//   vouches for nothing there.
// - Who reads it: the retire hook, for that one question, and the launch that adds to it.
//   No other verb does: which threads are a home's stays by project, environment and the
//   recorded endpoint.
//
// The agent runs as the same user (bb's full mode has no sandbox): the record is out of
// its home, not out of its reach. A sandboxed launch denies it (lib/deny.mjs).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isBbId } from "./threads.mjs";

// A record holds ids only: one of a home that started ten thousand times is under 200 KiB.
const MAX_BYTES = 1024 * 1024;
const HEADER = /^oats-bb-home 1 dev=(\d{1,20}) ino=(\d{1,20}) birth=(\d{1,20}|-)$/;
const DIR_MODE = 0o700, FILE_MODE = 0o600;

/** Why a record could not be written, or read: never a refusal of the provider's. */
export class RecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecordError";
  }
}

/** The provider's state directory: `$XDG_STATE_HOME/oats-bb`, or `.local/state/oats-bb`
 *  in the user's home where the variable is unset or is not an absolute path (the XDG
 *  rule), on every platform. */
export function stateRoot(env = process.env, userHome = homedir()) {
  const given = env.XDG_STATE_HOME;
  return join(typeof given === "string" && isAbsolute(given) ? given : join(userHome, ".local", "state"), "oats-bb");
}

/** Where the homes' records are. */
export const recordDir = (env, userHome) => join(stateRoot(env, userHome), "homes");

/** A home directory's identity: its real path, and the device, the inode and the birth
 *  time of the directory there (`birth` null where the platform or the filesystem gives
 *  none: Node then reports 0). Throws where the home is no directory. */
export function identityOf(home) {
  const real = realpathSync(home);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new RecordError("the home is not a directory");
  return { real, dev: stat.dev, ino: stat.ino, birth: stat.birthtimeNs > 0n ? stat.birthtimeNs : null };
}

/** Whether a record's identity is the directory's. The provider's own rule, stricter than
 *  the kernel's (which takes device and inode): a filesystem may give a deleted
 *  directory's inode to a new one, as ext4 does.
 *  - A record that holds a birth time matches only where the inode AND the birth time are
 *    equal, whatever the device: btrfs gives a subvolume another device number at each
 *    boot, and the directory is the same one.
 *  - A record that holds none matches only where the device AND the inode are equal. */
export function sameHome(recorded, actual) {
  if (recorded.birth !== null) return actual.birth !== null && recorded.ino === actual.ino && recorded.birth === actual.birth;
  return recorded.dev === actual.dev && recorded.ino === actual.ino;
}

const headerOf = (identity) => `oats-bb-home 1 dev=${identity.dev} ino=${identity.ino} birth=${identity.birth ?? "-"}`;
const fileOf = (dir, real) => join(dir, createHash("sha256").update(real).digest("hex"));
const me = () => (typeof process.geteuid === "function" ? process.geteuid() : null);

/** Why a directory of the record is not one the provider keeps: a real directory (never a
 *  link), this user's, with mode 0700. → null | text; undefined where there is none. */
function dirProblem(path, uid) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory()) return `${path} is not a directory`;
  if (uid === null || stat.uid !== uid) return `${path} is another user's`;
  if ((stat.mode & 0o777) !== DIR_MODE) return `${path} has mode ${(stat.mode & 0o777).toString(8)}, not 700`;
  return null;
}

/** What an open record file holds. → {state: "ok", identity, ids} | {state: "unreadable",
 *  why} | {state: "malformed", why}. Unreadable: not a regular file with one name, another
 *  user's, a mode other than 0600, larger than a record gets, or a read that failed.
 *  Malformed: anything but the identity line and whole lines of one thread id each (a
 *  line cut short by a write that did not finish is that). */
function parse(fd, uid) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) return { state: "unreadable", why: "it is not a regular file with one name" };
  if (uid === null || stat.uid !== uid) return { state: "unreadable", why: "it is another user's" };
  if ((stat.mode & 0o777) !== FILE_MODE) return { state: "unreadable", why: `its mode is ${(stat.mode & 0o777).toString(8)}, not 600` };
  if (stat.size > MAX_BYTES) return { state: "unreadable", why: "it is larger than a record gets" };
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let got = 0;
  for (;;) {
    const read = readSync(fd, buffer, got, buffer.length - got, got);
    if (read === 0) break;
    got += read;
    if (got > MAX_BYTES) return { state: "unreadable", why: "it is larger than a record gets" };
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, got)); }
  catch { return { state: "malformed", why: "it is not text" }; }
  if (!text.endsWith("\n")) return { state: "malformed", why: text === "" ? "it is empty" : "its last line was not written whole" };
  const [first, ...lines] = text.slice(0, -1).split("\n");
  const header = HEADER.exec(first);
  if (header === null) return { state: "malformed", why: "its first line is not a home's identity" };
  const bad = lines.findIndex((line) => !isBbId(line));
  if (bad !== -1) return { state: "malformed", why: `its line ${bad + 2} is not one thread id` };
  return { state: "ok", identity: { dev: BigInt(header[1]), ino: BigInt(header[2]), birth: header[3] === "-" ? null : BigInt(header[3]) }, ids: new Set(lines) };
}

/** Open the record file, never through a link and never waiting on one that is no file.
 *  → fd | {state: "missing"} | {state: "unreadable", why}. */
function open(file, flags) {
  try { return openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", why: error.code === "ELOOP" ? "it is a link" : `it could not be opened (${error.code ?? error.message})` };
  }
}

/** The record of the home, for the retire hook. Never throws.
 *  → { state, file, ids?, why? }, `state` one of:
 *  - "ok": the record is this home's (sameHome), and `ids` (a Set) is every thread the
 *    provider made for it;
 *  - "missing": there is none (a home spawned before the provider kept one; a home that
 *    never launched on bb);
 *  - "mismatch": there is one for this path, of another directory (an earlier home there):
 *    it vouches for nothing here;
 *  - "unreadable", "malformed": with `why`.
 *  `file` is the record's path where one was found, for removeRecord. */
export function readRecord(home, { env = process.env, userHome, uid = me() } = {}) {
  let actual;
  try { actual = identityOf(home); }
  catch (error) { return { state: "unreadable", why: `the home's directory could not be read (${error.code ?? error.message})`, file: null }; }
  const root = stateRoot(env, userHome), dir = recordDir(env, userHome);
  for (const path of [root, dir]) {
    let problem;
    try { problem = dirProblem(path, uid); }
    catch (error) { return { state: "unreadable", why: `${path} could not be read (${error.code ?? error.message})`, file: null }; }
    if (problem === undefined) return { state: "missing", file: null };
    if (problem !== null) return { state: "unreadable", why: problem, file: null };
  }
  const file = fileOf(dir, actual.real);
  const fd = open(file, constants.O_RDONLY);
  if (typeof fd !== "number") return { ...fd, file: fd.state === "missing" ? null : file };
  try {
    const record = parse(fd, uid);
    if (record.state !== "ok") return { ...record, file };
    if (!sameHome(record.identity, actual)) return { state: "mismatch", file };
    return { state: "ok", ids: record.ids, file };
  } catch (error) {
    return { state: "unreadable", why: `it could not be read (${error.code ?? error.message})`, file };
  } finally { closeSync(fd); }
}

/** Remove a record the retire hook has read (`readRecord`'s answer), once it has decided.
 *  This home's, or one that can never be read as a home's (malformed). One of another
 *  directory at this path, and one that is not a file of the provider's (unreadable), are
 *  left as they are: they are not this home's to remove. Throws RecordError where the
 *  file could not be removed. */
export function removeRecord(record) {
  if (record.file === null || (record.state !== "ok" && record.state !== "malformed")) return;
  try { unlinkSync(record.file); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw new RecordError(`the home's thread record could not be removed (${error.code ?? error.message})`);
  }
}

/** Note a thread the provider made for the home: one whole line added to its record, or
 *  a new record where there is none for this directory (none at all; one of an earlier
 *  home at this path; one that is malformed, which could never vouch for anything again).
 *  Throws RecordError where it could not be written: the caller's launch goes on, and the
 *  thread is then unmarked, so the retire archives and deletes no environment. */
export function noteThread(home, threadId, { env = process.env, userHome, uid = me() } = {}) {
  if (!isBbId(threadId)) throw new RecordError("the thread's id is not a bb id");
  let fd = null, temporary = null;
  try {
    const actual = identityOf(home);
    const root = stateRoot(env, userHome), dir = recordDir(env, userHome);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    for (const path of [root, dir]) {
      const problem = dirProblem(path, uid);
      if (problem) throw new RecordError(problem);
    }
    const file = fileOf(dir, actual.real);
    const line = Buffer.from(`${threadId}\n`);
    const opened = open(file, constants.O_RDWR | constants.O_APPEND);
    if (typeof opened === "number") {
      fd = opened;
      const record = parse(fd, uid);
      if (record.state === "unreadable") throw new RecordError(`the home's thread record is not the provider's to write: ${record.why}`);
      if (record.state === "ok" && sameHome(record.identity, actual)) {
        // One write of one whole line, at the file's end (O_APPEND).
        if (!record.ids.has(threadId) && writeSync(fd, line) !== line.length) throw new RecordError("the line was not written whole");
        return;
      }
      closeSync(fd);
      fd = null;
    } else if (opened.state !== "missing") throw new RecordError(`the home's thread record is not the provider's to write: ${opened.why}`);
    // A new record, written whole beside the old one and put in its place by a rename.
    temporary = join(dir, `.new-${randomBytes(8).toString("hex")}`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    fchmodSync(fd, FILE_MODE);
    const whole = Buffer.from(`${headerOf(actual)}\n${threadId}\n`);
    if (writeSync(fd, whole) !== whole.length) throw new RecordError("the record was not written whole");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    temporary = null;
  } catch (error) {
    throw error instanceof RecordError ? error : new RecordError(`${error.code ?? error.message}`);
  } finally {
    if (fd !== null) closeSync(fd);
    if (temporary !== null) {
      try { unlinkSync(temporary); }
      catch { /* the write's own failure is what is said; a leftover holds one thread id */ }
    }
  }
}
