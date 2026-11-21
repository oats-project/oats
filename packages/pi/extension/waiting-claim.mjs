/**
 * waiting-claim.mjs — the bridge's waiting claim on its home: the kernel's own
 * (`oats instance waiting`, producer `oats.pi`), which shows the instance as
 * needing input and, with reason `question`, holds a scheduled wake's Enter.
 *
 * A producer holds one claim, and the bridge has two things to say: a dialog is
 * open (ui-prompt.mjs) and the last turn failed (failed-turn.mjs). The open
 * dialog is shown over the failed turn, because an Enter would answer it, and a
 * dialog that closes shows the failed turn again while it still stands.
 *
 * More than one bridge can run in a home: a nested pi or a subagent's session
 * carries the home's OATS_INSTANCE_HOME too, and a pi can die with its dialog
 * open. So the bridge that sets the claim records a mark beside it, in pi's own
 * project directory: `<home>/.pi/oats-pi-claim.json`, `{ pid, start, token,
 * reason }`, the holder's process (its pid and start time, so a reused pid is
 * not taken for it), this bridge (the token) and the claim's reason. A bridge
 * clears only the claim its own mark stands for, by the mark and never by the
 * claim's reason, and a holder that is alive keeps its claim: another bridge
 * leaves it, except that a question replaces a live holder's failed turn. The
 * mark is in the agent's own home and decides only claims the agent could set
 * or clear itself.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The characters the kernel refuses in a claim's message: a copy of its set
 *  (lib/refused-text.mjs REFUSED_TEXT), which this package cannot import before it
 *  has found the kernel. A claim the kernel refuses is a stuck instance nobody
 *  sees. A test pins the two equal. */
export const MESSAGE_REFUSED = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/gu;
/** The kernel's longest message, in code points (lib/instance-events.mjs WAITING_MESSAGE_MAX). */
const MESSAGE_MAX = 200;

/** One message the kernel accepts, whatever the text: one line, the refused
 *  characters replaced, cut to fit. "" for a text that says nothing. */
export function claimMessage(text) {
  const line = typeof text === "string" ? text.replace(/\s+/gu, " ").trim().replace(MESSAGE_REFUSED, "\ufffd") : "";
  const points = [...line];
  return points.length > MESSAGE_MAX ? `${points.slice(0, MESSAGE_MAX - 1).join("")}…` : line;
}

/** Where a home's mark is. */
export const markPath = (home) => join(home, ".pi", "oats-pi-claim.json");

/** A Linux process's state letter and start time, from its stat (fields 3 and 22, counted
 *  after the command's closing parenthesis, which a command name cannot spoof), or null. */
function procStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ? { state: fields[0], start: fields[19] } : null;
  } catch { return null; }
}

/** When a process started, as a string that is the same for every reader while it
 *  lives, or null where that cannot be read. Linux: the start time in its stat.
 *  Elsewhere: what `ps` prints for it. */
export function processStart(pid) {
  const stat = procStat(pid);
  if (stat) return stat.start;
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

/** Whether the process a mark names is still that process. One that cannot be told
 *  apart from it counts as alive: a live holder's claim taken for a dead one's would
 *  be cleared under an open dialog. A process that has exited and waits for its
 *  parent to reap it (Linux state Z, or X) is gone; where there is no /proc, such a
 *  one counts as alive until it is reaped. */
function holderAlive(mark) {
  try { process.kill(mark.pid, 0); }
  catch (error) { if (error?.code !== "EPERM") return false; }
  const state = procStat(mark.pid)?.state;
  if (state === "Z" || state === "X") return false;
  const start = processStart(mark.pid);
  return start === null || mark.start === null || start === mark.start;
}

/** The home's mark, or null: none, or one that does not read as a mark. */
function readMark(home) {
  try {
    const mark = JSON.parse(readFileSync(markPath(home), "utf8"));
    const valid = Number.isInteger(mark?.pid) && mark.pid > 0 && (mark.start === null || typeof mark.start === "string")
      && typeof mark.token === "string" && (mark.reason === "question" || mark.reason === "attention");
    return valid ? mark : null;
  } catch { return null; }
}

/** The home's claim: `asked(message)` while a dialog is open (a string, "" for one
 *  with no words) and `asked(undefined)` once it closed; `turnFailed(message)` for a
 *  turn that failed and `turnFailed(undefined)` once that is over.
 *
 *  Each change is one step, and steps run one at a time, so a clear cannot pass the
 *  set it answers. A step shows what stands when it runs, so a dialog that opened and
 *  closed while an earlier write was under way starts no process. A step reads the
 *  mark, then:
 *  - to show a claim: writes its own mark, then the claim. A live holder's claim
 *    stays instead, unless this one is a question and that one a failed turn. A
 *    bridge so blocked looks again every second while it still has a claim to show,
 *    so a second pi's open dialog is claimed once the first pi's has closed.
 *  - to show none: clears the claim its own mark stands for, then removes the mark.
 *    Once a run has started, this bridge's first such step also clears what nobody
 *    alive holds: a mark whose holder is gone, or a claim with no mark (a bridge
 *    from before the mark left it, or a session that ended on a failed turn). A
 *    session that starts and ends with no run clears no leftover. After that, a
 *    step with no claim to clear starts no process, and only reads the mark: it
 *    clears the question of a holder that is gone, a second pi that died with its
 *    dialog open while this one lives.
 *  - when its session starts (`session_start`): clears only the question of a holder
 *    that is gone, a pi that died with its dialog open. A failed turn waits for the
 *    next run, as before.
 *
 *  A session that ends closes its dialog and waits for its steps: a /reload's next
 *  bridge starts its own, a set still under way would land after its clear, and a pi
 *  that exits would leave a dialog's claim behind. A failed turn's claim outlives the
 *  session, as before, and gives up its mark, so the next bridge's first run clears
 *  it. A write is bounded by its timeout. A set the kernel did not take is dropped,
 *  as is a mark that cannot be written; a clear it did not take keeps the mark and is
 *  tried again at the bridge's next step, and a question's by itself too, at growing
 *  waits, because a question left standing holds every wake. Reporting must never
 *  break a session.
 *
 *  Two bridges are not fenced against each other: a step reads the mark and then
 *  writes, so a clear that read "nobody alive holds it" can land after another pi's
 *  set, and that pi's dialog then has no claim until it closes. The window is the
 *  two kernel calls' jitter. A failed turn that another pi's question replaced is
 *  not shown again when that dialog closes: its bridge learns of it only at its
 *  next step. A dialog that opens before this bridge's first run takes a leftover
 *  failed turn with it, for the same reason: the question replaces the producer's
 *  one claim, and this bridge has no failed turn of its own to show again. */
/** How often a bridge whose claim a live holder blocks looks again, in ms. */
const BLOCKED_RETRY_MS = 1000;
/** The longest wait before a question's clear the kernel did not take is tried again, in ms: the
 *  wait starts at BLOCKED_RETRY_MS and doubles, so a kernel that keeps failing costs a process a
 *  minute, not one a second. */
const CLEAR_RETRY_MAX_MS = 60000;
/** The tokens of this process's bridges whose session has not ended, shared by every copy of this
 *  module pi loads (a /reload and a session replacement load it again in the same process). A mark
 *  of this process whose token is not here is an ended bridge's: nobody's. */
const LIVE_BRIDGES = (globalThis[Symbol.for("@awebai/oats-pi/waiting-claim/live-bridges")] ??= new Set());

export function waitingClaim(pi, home) {
  const self = { pid: process.pid, start: processStart(process.pid), token: randomUUID() };
  const mine = (mark) => mark !== null && mark.pid === self.pid && mark.token === self.token;
  /** Whether a mark's holder is alive: another process that is (holderAlive), or a bridge of this
   *  process whose session has not ended. */
  const alive = (mark) => mark.pid === self.pid && mark.start === self.start ? LIVE_BRIDGES.has(mark.token) : holderAlive(mark);
  LIVE_BRIDGES.add(self.token);
  let question;
  let failure;
  // What this bridge's claim says, "" for none; undefined until its first step.
  let shown;
  let steps = Promise.resolve();
  // The timer of this bridge's next look (blocked by a live holder, or after a question's clear the
  // kernel did not take), how many such clears in a row, and whether the session has ended (no
  // look after).
  let retry;
  let refused = 0;
  let ended = false;
  // Whether a run has started or ended in this bridge's time: only then is a leftover its to clear.
  let ran = false;

  /** One kernel call. Whether the kernel took it: false for a refusal, a failure and the timeout. */
  const waiting = (...args) => new Promise((done) => {
    const argv = ["instance", "waiting", ...args, "--producer", "oats.pi", "--home", home, "--json"];
    execFile(join(home, ".oats", "bin", "oats"), argv, { cwd: home, timeout: 5000 }, (error) => done(!error));
  });
  /** Remove a file of the mark's. One that stays is harmless: a mark reads as its holder's while that
   *  lives and as nobody's after, and a draft is never read. */
  const drop = (path) => {
    try { rmSync(path, { force: true }); }
    catch { /* left where it is */ }
  };
  const writeMark = (reason) => {
    const path = markPath(home), draft = `${path}.${self.pid}.${self.token}`;
    try {
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(draft, `${JSON.stringify({ ...self, reason })}\n`);
      renameSync(draft, path);
    } catch { drop(draft); }
  };
  const removeMark = () => drop(markPath(home));
  /** Clear the claim, then remove the mark, unless a live holder wrote its own meanwhile. False when
   *  the kernel did not take the clear: the claim may stand, so the mark stays, for a later try by
   *  this bridge or, once this pi is gone, by the home's next one. */
  const clearClaim = async () => {
    if (!(await waiting("clear"))) return false;
    const left = readMark(home);
    if (left === null || mine(left) || !alive(left)) removeMark();
    return true;
  };
  /** One step after the others. A step that throws is dropped: reporting must never break a session. */
  const then = (run) => { steps = steps.then(run).catch(() => undefined); };

  const wanted = () => question !== undefined ? ["question", question] : failure !== undefined ? ["attention", failure] : [];
  /** Take the next step by itself after a wait, unless the session has ended. Any step cancels it. */
  const lookAgain = (ms) => {
    if (ended) return;
    retry = setTimeout(() => change(), ms);
    retry.unref?.();
  };
  /** Clear the question of a holder that is gone: a pi that died with its dialog open. */
  const clearDeadQuestion = async () => {
    const mark = readMark(home);
    if (mark === null || mark.reason !== "question" || mine(mark) || alive(mark)) return;
    await clearClaim();
  };
  const step = async () => {
    clearTimeout(retry);
    const [reason, message] = wanted();
    const next = reason === undefined ? "" : `${reason} ${message}`;
    if (next === shown) {
      // Nothing to show and nothing shown: a look at the mark, for a second pi's question that
      // outlived it. A run's start comes here, so a live pi clears it within a run.
      if (next === "") await clearDeadQuestion();
      return;
    }
    const first = shown === undefined;
    const mark = readMark(home);
    const other = mark !== null && !mine(mark) && alive(mark) ? mark : null;
    if (reason === undefined) {
      // Nothing of its own yet, and what an earlier pi left waits for a run.
      if (first && !ran) return;
      // Its own claim, or on its first run a leftover, unless a live holder has the claim. A clear
      // the kernel did not take is tried again at this bridge's next step, and a question's by
      // itself too, at growing waits: left standing in a quiet session, it would hold the very wake
      // that session waits for.
      const before = shown;
      shown = "";
      if (other !== null) return;
      if (await clearClaim()) { refused = 0; return; }
      shown = before;
      if (before?.startsWith("question ")) lookAgain(Math.min(CLEAR_RETRY_MAX_MS, BLOCKED_RETRY_MS * 2 ** refused++));
      return;
    }
    if (other !== null && !(reason === "question" && other.reason === "attention")) {
      // The holder's claim stays, and this bridge shows none. Blocked on its first step, it has
      // yet to look for a leftover.
      shown = first ? undefined : "";
      lookAgain(BLOCKED_RETRY_MS);
      return;
    }
    shown = next;
    writeMark(reason);
    await waiting("set", "--reason", reason, ...(message ? [`--message=${message}`] : []));
  };
  const change = () => then(step);

  pi.on("session_start", () => {
    ended = false;
    LIVE_BRIDGES.add(self.token);
    then(clearDeadQuestion);
  });
  pi.on("session_shutdown", () => {
    ended = true;
    question = undefined;
    change();
    // A failed turn's claim outlives the session and gives up its mark. A question whose clear the
    // kernel did not take keeps its mark, and this bridge is live no more: the next bridge of this
    // process, or the home's next pi, clears it as it starts.
    then(() => {
      if (shown?.startsWith("attention ") && mine(readMark(home))) removeMark();
      LIVE_BRIDGES.delete(self.token);
    });
    return steps;
  });
  return {
    asked(message) { question = message; change(); },
    turnFailed(message) { ran = true; failure = message; change(); },
  };
}
