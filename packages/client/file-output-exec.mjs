/** The exec of a kernel change that must outlive the client: `execFile`'s signature and return (the child), with
 * the child's output in files, never in pipes. A client that quits, crashes or is signalled while a pipe's reader
 * is its own leaves the child writing into a pipe nobody reads: the write meets EPIPE (or SIGPIPE) and the change
 * dies half done. So the child writes to files of its own, which nothing the client does can close.
 *
 *   execFileToFiles(bin, argv, { cwd, env, encoding, maxBuffer }, callback) -> ChildProcess
 *
 * - The child starts in a session of its own (`detached`; `execFile` drops that option, so this stands on
 *   `spawn`), stdin `ignore`: a signal to the client's process group (Ctrl-C, a hang-up) never reaches it.
 * - Before the spawn: a private dir (`mkdtemp` under the OS temp dir, mode 0700) and two files in it (`wx`,
 *   0600), each with a write fd and a read fd. The write fds are the child's stdout and stderr. Right after the
 *   spawn the client's write fds are closed, both files unlinked and the dir removed: the child writes to its
 *   open inodes, the client reads back from its own fds, nothing is left on disk even after a client crash, and
 *   no path is reused. Any failure before the spawn returns closes and removes what was made, then throws.
 * - On the child's `close`, each read fd is read from position 0, bounded by `maxBuffer` (default 1 MiB, as
 *   execFile): more is a RangeError with code ERR_CHILD_PROCESS_STDIO_MAXBUFFER, over any exit status, with what
 *   fits passed on. The fds are closed, then the callback is called once, as execFile calls it: `(null, stdout,
 *   stderr)` after exit 0 with no signal; otherwise an Error with `code` (the exit status), `signal` and
 *   `killed: false`, and no text of the child's output in its message (it names the command, as execFile's). Text is `encoding` (default utf8); `'buffer'` or null gives Buffers. A spawn that
 *   fails (no pid) calls back with its error and empty output.
 * - IT NEVER SIGNALS THE CHILD: no kill timer, and a nonzero `timeout` throws a TypeError (no caller of this exec
 *   gives one; a caller ends its own wait, never the child). `shell` and `killSignal` are not read.
 * The TUI's `changeExec` (packages/tui/lib/read.mjs) keeps the same promise with its own lifecycle bookkeeping
 * (its run's directory, its let-go on the way out). */
import { withoutControlToken } from "./control-environment.mjs";
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The name every private dir of this exec starts with, under the OS temp dir. */
export const FILE_OUTPUT_PREFIX = 'oats-output-';
const STREAMS = ['stdout', 'stderr'];
const quietly = (fn) => { try { return fn(); } catch { return undefined; } };

/** At most `max` + 1 bytes of `fd` from position 0: `{ data, over }`. */
function readBack(fd, max) {
  const size = fstatSync(fd).size, room = Number.isFinite(max) ? Math.min(size, max + 1) : size;
  const buffer = Buffer.alloc(room);
  let got = 0;
  while (got < room) { const n = readSync(fd, buffer, got, room - got, got); if (n === 0) break; got += n; }
  const over = got > max;
  return { data: buffer.subarray(0, over ? max : got), over };
}

export function execFileToFiles(bin, argv, options = {}, callback = () => {}) {
  const { cwd, env, encoding = 'utf8', timeout, maxBuffer = 1024 * 1024 } = options ?? {};
  if (timeout !== undefined && timeout !== null && timeout !== 0) throw new TypeError('execFileToFiles never signals its child: a timeout is refused');
  if (typeof maxBuffer !== 'number' || !(maxBuffer >= 0)) throw new TypeError('maxBuffer must be a number of bytes, 0 or more');
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const text = (data) => (encoding && encoding !== 'buffer' ? data.toString(encoding) : data);

  const write = {}, read = {}, paths = {};
  let dir = null;
  const removeFiles = () => {
    for (const name of STREAMS) if (paths[name] !== undefined) quietly(() => unlinkSync(paths[name]));
    if (dir !== null) quietly(() => rmdirSync(dir));
  };
  const closeAll = (fds) => { for (const name of STREAMS) if (fds[name] !== undefined) quietly(() => closeSync(fds[name])); };
  let child;
  try {
    dir = mkdtempSync(join(tmpdir(), FILE_OUTPUT_PREFIX));
    chmodSync(dir, 0o700);
    for (const name of STREAMS) {
      const path = join(dir, name);
      write[name] = openSync(path, 'wx', 0o600);
      paths[name] = path;
      read[name] = openSync(path, 'r');
    }
    child = spawn(bin, argv, { cwd, env: withoutControlToken(env), detached: true, stdio: ['ignore', write.stdout, write.stderr], shell: false, windowsHide: true });
  } catch (error) {
    closeAll(write); closeAll(read); removeFiles();
    throw error;
  }
  // The child holds its own copies now: the client's write fds, the names and the dir go at once.
  closeAll(write); removeFiles();

  let over = false;
  function finish(error, readOutput) {
    if (over) return;
    over = true;
    const output = {};
    let verdict = error;
    for (const name of STREAMS) {
      const taken = readOutput ? quietly(() => readBack(read[name], maxBuffer)) : undefined;
      output[name] = text(taken?.data ?? Buffer.alloc(0));
      if (taken?.over && verdict?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') verdict = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    }
    closeAll(read);
    callback(verdict, output.stdout, output.stderr);
  }
  child.once('close', (code, signal) => {
    const clean = code === 0 && signal === null;
    finish(clean ? null : Object.assign(new Error(`Command failed: ${[bin, ...argv].join(' ')}`), { code, signal, killed: false, cmd: [bin, ...argv].join(' ') }), true);
  });
  // A spawn that failed has no pid; an error of a started child (none is expected: nothing signals it) waits for its close.
  child.on('error', (error) => { if (!Number.isInteger(child.pid)) finish(error, false); });
  return child;
}
