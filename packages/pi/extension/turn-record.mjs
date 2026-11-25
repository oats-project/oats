/**
 * turn-record.mjs — the bridge's turn record: whether this pi works on a turn
 * now or waits at its prompt, for the home's status row (`activity`, the
 * kernel's feature status-activity, lib/turn-activity.mjs).
 *
 * The record is one file, `<home>/.oats/turn.json`, holding the last turn
 * boundary: `{ "event": "turn-start" | "turn-end", "at": "<ISO>" }`. The
 * bridge writes turn-start at pi's agent_start and turn-end at its agent_end,
 * which pi fires for every run that ends, an aborted one and a failed one
 * included. A launch prompt (`@TASK.md`) is a run like any other, so a start's
 * first turn is recorded too. Each write replaces the file whole: a draft
 * beside it, then a rename, so the kernel never reads half a record.
 *
 * Only the kernel reads it, for a tmux home whose harness it sees running,
 * and only a boundary dated at or after the home's current start counts: a
 * record a pi left when it was killed mid-turn is never read as this
 * session's. The bridge writes it in every home, whatever its backend (it does
 * not know which it runs on); on a session provider's home the kernel never
 * reads it. A kernel from before the feature never reads it either.
 *
 * Only the home's own pi session writes. A second pi in the home carries the
 * home's OATS_INSTANCE_HOME and loads this bridge too, and its runs end while
 * the home's own turn goes on: its turn-end would read idle for the rest of
 * that turn. There are two kinds, and a rule for each:
 * - a session in the same process (a subagent's or a workflow agent's, which
 *   pi-extensible-workflows runs in the pi that started it): the first bridge
 *   of a process to load is the home's session, and holds the process's
 *   writer until its session shuts down. While it holds it, every other
 *   bridge in the process writes nothing. A /reload or a replaced session
 *   shuts the holder down, and the bridge that follows takes the writer.
 * - a pi in another process (a nested `pi`, a subagent run as a command): the
 *   writing bridge marks its own process environment,
 *   `OATS_PI_TURN_WRITER={"pid","start","home"}` (JSON), which a pi started
 *   below it inherits: a bridge that finds the mark of another process that
 *   is still alive, for this home, writes nothing. The mark is this package's
 *   alone: no kernel, hook or launch environment reads or sets it. A mark for
 *   another home (an instance spawned from inside this pi) is not this
 *   home's.
 * Both are looked at when a run starts, so a bridge whose writer has gone takes
 * over at its next run, and a run's end is written by the bridge that wrote
 * its start. A subagent that works on after the home's own turn has ended is
 * not the home's turn: the row reads idle.
 *
 * A retried turn has an agent_end and an agent_start for each attempt, so the
 * record reads idle between two attempts, for the length of pi's backoff.
 *
 * Recording must never break a session: a write that fails is dropped, and
 * the row then keeps the last boundary that was written.
 */
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holderAlive, processStart } from "./waiting-claim.mjs";

/** The two boundaries, as the kernel reads them (lib/turn-activity.mjs TURN_EVENT). A test pins them equal. */
export const TURN_START = "turn-start";
export const TURN_END = "turn-end";
/** Where a home's record is. */
export const turnPath = (home) => join(home, ".oats", "turn.json");

/** Replace the home's record with `event` at `now()`. Whether it was written: false where the home
 *  has no `.oats` directory, or the file cannot be written or renamed; no draft is left behind. The
 *  draft's name is one the kernel's retire digest passes over, as it does over the record. */
export function writeTurn(home, event, { now = () => new Date() } = {}) {
  const path = turnPath(home), draft = `${path}.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(draft, `${JSON.stringify({ event, at: now().toISOString() })}\n`);
    renameSync(draft, path);
    return true;
  } catch {
    // The draft may or may not exist. One that stays is never read, by anyone.
    try { rmSync(draft, { force: true }); }
    catch { /* left where it is */ }
    return false;
  }
}

/** The variable of the writer's mark, in the bridge's own process environment. */
export const TURN_WRITER = "OATS_PI_TURN_WRITER";

/** A writer's mark as its variable holds it: JSON, so that no field's text can be read as another's
 *  (a process start is `ps`'s words where there is no /proc, colons and spaces included, and a home
 *  is any path). */
export const formatTurnWriter = ({ pid, start, home }) => JSON.stringify({ pid, start, home });
/** The mark a variable's value holds → `{ pid, start, home }`, or null for none: no value, no JSON
 *  object, a pid that is no positive integer, a start that is neither a string nor null, no home. */
export function parseTurnWriter(value) {
  try {
    const mark = JSON.parse(value);
    const valid = mark !== null && typeof mark === "object" && !Array.isArray(mark) && Number.isInteger(mark.pid) && mark.pid > 0
      && (mark.start === null || typeof mark.start === "string") && typeof mark.home === "string";
    return valid ? { pid: mark.pid, start: mark.start, home: mark.home } : null;
  } catch { return null; }
}

/** Whether this process is the home's writer, taking the mark when nobody alive holds it for this
 *  home. `env`: the process environment, where the mark is read and set. A holder is alive by the
 *  claim mark's rule (waiting-claim.mjs holderAlive): its pid is there, not a process that has
 *  exited and waits to be reaped, and started when the mark says; one whose start cannot be read
 *  counts as alive. */
export function takeTurnWriter(home, env = process.env) {
  const mark = parseTurnWriter(env[TURN_WRITER]);
  if (mark !== null && mark.home === home && mark.pid !== process.pid && holderAlive(mark)) return false;
  env[TURN_WRITER] = formatTurnWriter({ pid: process.pid, start: processStart(process.pid), home });
  return true;
}

/** The sessions that hold the writer in this process, by home: home → the holding bridge's token.
 *  Shared by every copy of this module pi loads (a /reload and a subagent's session load it again
 *  in the same process). */
const SESSION_WRITERS = (globalThis[Symbol.for("@awebai/oats-pi/turn-record/session-writers")] ??= new Map());

/** Record this pi session's turn boundaries in `home`, where it is the home's writer: the session
 *  that holds the writer in this process, in a process that holds it for the home (takeTurnWriter). */
export function recordTurns(pi, home, { now, env = process.env } = {}) {
  const token = randomUUID();
  /** Whether this bridge holds the process's writer, taking it when no session does. */
  const holds = () => {
    if (!SESSION_WRITERS.has(home)) SESSION_WRITERS.set(home, token);
    return SESSION_WRITERS.get(home) === token;
  };
  // The first bridge to load is the home's own session: a subagent's loads inside one of its runs.
  holds();
  // Whether this bridge wrote the start of the run under way: its end is then this bridge's too.
  let wrote = false;
  pi.on("agent_start", () => {
    wrote = holds() && takeTurnWriter(home, env);
    if (wrote) writeTurn(home, TURN_START, { now });
  });
  pi.on("agent_end", () => {
    if (wrote) writeTurn(home, TURN_END, { now });
    wrote = false;
  });
  pi.on("session_shutdown", () => {
    if (SESSION_WRITERS.get(home) === token) SESSION_WRITERS.delete(home);
  });
}
