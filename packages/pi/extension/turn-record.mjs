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
 * A retried turn has an agent_end and an agent_start for each attempt, so the
 * record reads idle between two attempts, for the length of pi's backoff.
 *
 * Recording must never break a session: a write that fails is dropped, and
 * the row then keeps the last boundary that was written.
 */
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Record this pi's turn boundaries in `home`. */
export function recordTurns(pi, home, { now } = {}) {
  pi.on("agent_start", () => { writeTurn(home, TURN_START, { now }); });
  pi.on("agent_end", () => { writeTurn(home, TURN_END, { now }); });
}
