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
 * Only the home's own pi writes. A second pi in the home (a nested one, a
 * subagent's or a workflow agent's process) carries the home's
 * OATS_INSTANCE_HOME and loads this bridge too, and its runs end while the
 * home's own turn goes on: its turn-end would read idle for the rest of that
 * turn. So the bridge that records marks its own process environment,
 * `OATS_PI_TURN_WRITER=<pid>:<process start>:<home>`, which a pi started below
 * it inherits: a bridge that finds the mark of another process that is still
 * alive, for this home, writes nothing. The mark is this package's alone: no
 * kernel, hook or launch environment reads or sets it. It is looked at when a
 * run starts, so a pi whose writer has gone takes over at its next run, and a
 * run's end is written by the bridge that wrote its start. A second session in
 * one process (a /reload, a replaced session) is the same writer. A mark for
 * another home (an instance spawned from inside this pi) is not this home's.
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
import { processStart } from "./waiting-claim.mjs";

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

/** Whether the process a mark names is still that process: it is there, and started when the mark
 *  says (a reused pid is another process). One whose start cannot be read counts as alive. */
function markedAlive(pid, start) {
  try { process.kill(pid, 0); }
  catch (error) { if (error?.code !== "EPERM") return false; }
  const now = processStart(pid);
  return now === null || start === "" || now === start;
}

/** Whether this process is the home's writer, taking the mark when nobody alive holds it for this
 *  home. `env`: the process environment, where the mark is read and set. */
export function takeTurnWriter(home, env = process.env) {
  const [pid, start, ...rest] = String(env[TURN_WRITER] ?? "").split(":");
  const holder = Number(pid);
  if (rest.join(":") === home && Number.isInteger(holder) && holder > 0 && holder !== process.pid && markedAlive(holder, start)) return false;
  env[TURN_WRITER] = `${process.pid}:${processStart(process.pid) ?? ""}:${home}`;
  return true;
}

/** Record this pi's turn boundaries in `home`, where it is the home's writer (takeTurnWriter). */
export function recordTurns(pi, home, { now, env = process.env } = {}) {
  // Whether this bridge wrote the start of the run under way: its end is then this bridge's too.
  let wrote = false;
  pi.on("agent_start", () => {
    wrote = takeTurnWriter(home, env);
    if (wrote) writeTurn(home, TURN_START, { now });
  });
  pi.on("agent_end", () => {
    if (wrote) writeTurn(home, TURN_END, { now });
    wrote = false;
  });
}
