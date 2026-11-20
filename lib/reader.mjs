/** lib/reader.mjs — `oats reader --stdio`, the warm reader (awebai/oats#1630): a process a client starts as its own
 *  child, which answers `oats status --json` and `oats workspace status --json` over its stdin and stdout, many
 *  times, with the kernel's own read code (lib/roster-read.mjs and lib/workspace-read.mjs, through
 *  lib/read-call.mjs). The contract is docs/desktop-cli-api.md "The warm reader"; the decisions,
 *  docs/design/2026-10-29-warm-reader.md.
 *
 *  - Warm code, not warm data. Each request reads the deployment afresh: its answer is what `oats <argv>`, run by
 *    this install with the same environment and with cwd = `--dir`, prints and exits with. What the reader cannot
 *    answer that way it refuses, and the client runs the CLI.
 *  - One request at a time, in arrival order. The reads' module state is process-wide (lib/read-call.mjs
 *    READ_STATE), and so is the cwd: the children the reads run by name (tmux, git) resolve a relative PATH
 *    entry against it, so the reader chdirs to the request's `--dir` for the read and back to its install root
 *    when the request ends, never keeping a deployment directory that may go away. A second lane must first give
 *    each child its own cwd.
 *  - The install stamp (lib/install-stamp.mjs), taken before the kernel loads and again for each request: an install
 *    that changed under the reader (an upgrade, a Node upgrade) is never answered from the old code. That request and every queued one are refused E_READER_STALE, and the
 *    reader exits 0.
 *  - Its lifetime is the client's: stdin EOF or error, EPIPE on stdout, SIGTERM/SIGINT/SIGHUP end it. A request in
 *    flight is not answered, and its read session is closed from the `exit` handler, which kills its git
 *    children (a deployments-list lock, lib/dir-lock.mjs, raises a signal that arrived inside its
 *    section again once the lock is released, and this handler then ends the reader).
 *  - Its stdout carries protocol lines only: anything else written there (console.log) goes to stderr, and every
 *    child on the read path pipes or ignores its stdout.
 *  Kernel-private, not exported from `./core`. Dependency-free. */
import { isAbsolute, resolve } from "node:path";
import { expandInlineValues, flagValue } from "./argv.mjs";
import { inheritedContextRefusal } from "./captured-context.mjs";
import { listResolved } from "./deployments.mjs";
import { hotRead } from "./hot-reads.mjs";
import { installStamp } from "./install-stamp.mjs";
import { READER_API } from "./kernel-features.mjs";
import { callSession, parseMaxAge, readBudget, refusalAnswer, resetReadState } from "./read-call.mjs";
import { statusAnswer } from "./roster-read.mjs";
import { OATS_VERSION, PKG_ROOT } from "./version.mjs";
import { workspaceStatusAnswer } from "./workspace-read.mjs";

/** The reads a reader answers, by their hot-read names (lib/hot-reads.mjs hotRead): the hello's `reads`. */
export const READS = Object.freeze(["status", "workspace status"]);
/** The longest request line, in bytes, its newline not counted. */
export const LINE_LIMIT = 64 * 1024;
/** The longest `stderr` of an answer frame, in UTF-8 bytes. It is diagnostics only (the read session's notices), cut
 *  here so that a client's bound on an answer line, the CLI read's own output limit, is never passed for its sake. */
export const STDERR_LIMIT = 8 * 1024;
/** The modules the reads import lazily (by a literal `import()`), loaded before the hello so that the hello means
 *  ready: no request waits on a module load. test/reader-protocol.test.mjs pins it against the reads' closure. */
export const PRELOAD = Object.freeze({
  "member-clone": () => import("./member-clone.mjs"),
  drift: () => import("./drift.mjs"),
  semver: () => import("./semver.mjs"),
});

const BAD_REQUEST = "E_READER_BAD_REQUEST", UNSUPPORTED = "E_READER_UNSUPPORTED", STALE = "E_READER_STALE", DEFECT = "E_READER_DEFECT";
const validId = (id) => (typeof id === "string" && [...id].length <= 64) || Number.isSafeInteger(id);
const refused = (id, code, message) => ({ id, refused: { code, message } });

/** Run the reader on this process's stdin and stdout until its client ends it. Returns once it is listening. `stamp`
 *  is the install's stamp taken before any kernel module loaded (bin/oats.mjs; lib/install-stamp.mjs), the baseline
 *  every request is checked against. */
export async function runReader({ stamp }) {
  const stale = () => installStamp() !== stamp;
  process.chdir(PKG_ROOT);

  // stdout is the protocol's: every other write meant for it goes to stderr.
  const protocol = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const send = (frame) => new Promise((done) => { protocol(`${JSON.stringify(frame)}\n`, () => done()); });
  const end = (code) => process.exit(code);

  // The request in flight's read session: closed on any exit, which kills its git children.
  let inFlight = null;
  process.on("exit", () => inFlight?.closeNow());
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => {
    // Any other handler still listening ends the reader itself after this one.
    if (process.listenerCount(signal) === 1) end(code);
  });
  process.stdout.on("error", () => end(0)); // EPIPE: the client is gone
  process.stdin.on("end", () => end(0));
  process.stdin.on("error", () => end(0));

  for (const load of Object.values(PRELOAD)) await load();

  const queue = [];
  let pending = [], pendingBytes = 0, oversize = false, working = false, stopped = false;
  const take = (part, complete) => {
    if (!oversize) {
      pendingBytes += part.length;
      if (pendingBytes > LINE_LIMIT) { oversize = true; pending = []; } else if (part.length) pending.push(part);
    }
    if (!complete) return;
    queue.push(oversize ? { oversize: true } : { line: Buffer.concat(pending).toString("utf8") });
    pending = []; pendingBytes = 0; oversize = false;
  };

  /** Refuse `id` and every queued request as stale, then exit 0. */
  const refuseStale = async (id) => {
    stopped = true;
    process.stdin.pause();
    const message = "the kernel install changed since this reader started: run the read with the CLI, and start a new reader";
    await send(refused(id, STALE, message));
    for (const item of queue.splice(0)) await send(refused(requestOf(item).id ?? null, STALE, message));
    end(0);
  };

  const handle = async (item) => {
    const request = requestOf(item);
    if (request.refusal) return send(refused(request.id ?? null, BAD_REQUEST, request.refusal));
    const { id, argv } = request;
    if (stale()) return refuseStale(id);
    let frame;
    try {
      frame = await answer(argv, (session) => { inFlight = session; });
    } catch (e) {
      stopped = true;
      process.stderr.write(`${e?.stack ?? e}\n`);
      await send(refused(id, DEFECT, `the reader failed: ${e?.message ?? e}; run the read with the CLI`));
      return end(1); // per-request state may be half reset
    }
    if (stale()) return refuseStale(id);
    return send({ id, ...frame });
  };

  const pump = async () => {
    if (working) return;
    working = true;
    try { while (queue.length && !stopped) await handle(queue.shift()); } finally { working = false; }
  };

  process.stdin.on("data", (chunk) => {
    if (stopped) return;
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) { take(chunk.subarray(start, nl), true); start = nl + 1; }
    take(chunk.subarray(start), false);
    pump();
  });

  await send({ readerApi: READER_API, version: OATS_VERSION, reads: READS });
}

/** `text` cut to at most STDERR_LIMIT bytes of UTF-8, at a character boundary. */
export function boundedStderr(text) {
  if (Buffer.byteLength(text) <= STDERR_LIMIT) return text;
  let out = "", bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > STDERR_LIMIT) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** A queued line as a request: `{ id, argv }`, or `{ id?, refusal }` for a line that is none. */
function requestOf(item) {
  if (item.oversize) return { refusal: `a request line is at most ${LINE_LIMIT} bytes` };
  let request;
  try { request = JSON.parse(item.line); } catch { return { refusal: "a request is one JSON object on one line" }; }
  if (!request || typeof request !== "object" || Array.isArray(request)) return { refusal: "a request is one JSON object on one line" };
  if (!validId(request.id)) return { refusal: "a request's id is a string of at most 64 characters or a safe integer" };
  if (!Array.isArray(request.argv) || !request.argv.every((a) => typeof a === "string")) return { id: request.id, refusal: "a request's argv is an array of strings" };
  return { id: request.id, argv: request.argv };
}

/** One request's answer frame (without its id): `{ exit, answer, stderr? }`, or `{ refused }`. `track` is told the
 *  read session while it is open. Accepted: what hotRead classifies as one of READS, read with --json, with an
 *  absolute --dir. Then the CLI's own dispatch, in its order: the flag syntax, --max-age, the inherited context,
 *  then the read itself with its deployments-list observer. */
async function answer(argv, track) {
  const unsupported = (message) => ({ refused: { code: UNSUPPORTED, message: `${message}: run the read with the CLI` } });
  const read = hotRead(argv);
  if (!read || !READS.includes(read.form)) return unsupported(`this reader answers ${READS.map((r) => `oats ${r}`).join(" and ")} only`);
  const { argv: args, problem, inline } = expandInlineValues(argv);
  if (!args.includes("--json")) return unsupported("a request reads with --json");
  const given = flagValue(args, inline, "dir");
  if (typeof given !== "string" || !isAbsolute(given)) return unsupported("a request names its deployment with an absolute --dir");
  const dir = resolve(given);
  resetReadState(); // a refusal below carries no warning a previous request noted
  try { process.chdir(dir); } catch (e) { return unsupported(`--dir ${dir} cannot be the working directory (${e.code ?? e.message})`); }
  try {
    const said = ({ exit, answer: doc, stderr }) => ({ exit, answer: doc, ...(stderr ? { stderr: boundedStderr(stderr) } : {}) });
    if (problem) return said(refusalAnswer("E_BAD_ARGS", problem));
    let maxAge = null;
    if (args.includes("--max-age")) {
      const parsed = parseMaxAge(flagValue(args, inline, "max-age"));
      if (parsed.refusal) return said(refusalAnswer(parsed.refusal.code, parsed.refusal.message));
      maxAge = parsed.maxAge;
    }
    const captured = inheritedContextRefusal(process.env);
    if (captured) return said(refusalAnswer(captured.code, captured.message, captured.details));
    const session = callSession({ maxAge, budgetMs: readBudget(process.env) });
    track(session);
    try {
      const cacheDir = process.env.OATS_REMOTE_CACHE ? resolve(process.env.OATS_REMOTE_CACHE) : undefined;
      const ctx = { dir, maxAge, session: () => session, cacheDir, deployments: listResolved };
      if (read.form === "workspace status") return said(await workspaceStatusAnswer(ctx));
      const team = args.includes("--team");
      return said(await statusAnswer({ ...ctx, dir: team ? null : dir, team }));
    } finally {
      await session.close();
      track(null);
    }
  } finally {
    try { process.chdir(PKG_ROOT); } catch { /* the install is gone: the stamp says so */ }
  }
}
