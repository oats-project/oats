#!/usr/bin/env node
/**
 * claude-turn.mjs: the turn record of a Claude Code instance, for its status row.
 *
 *   node claude-turn.mjs <turn-start|turn-end|turn-end-idle> <home>
 *
 * Run by claude-waiting.sh (`turn`), which has already checked that <home> is the
 * home these hooks were written for and the one this session runs in. It replaces
 * `<home>/.oats/turn.json`, the last turn boundary of the session:
 * `{ "event": "turn-start" | "turn-end", "at": "<ISO>" }`. A kernel that lists the
 * feature `status-activity` reads it for a tmux home whose harness it sees running,
 * and shows the row as `activity: "working"` or `"idle"`; only a boundary dated at
 * or after the home's current start counts there, so a record a killed session
 * left is never read as the next one's. An older kernel never reads the file.
 *
 * Which hook writes what (oats-core.mjs claudeWaitingSettings):
 *   UserPromptSubmit                    turn-start   a prompt, a launch prompt's included
 *   Stop, StopFailure                   turn-end     the turn ended, by itself or on an API error
 *   Notification (idle_prompt)          turn-end-idle
 * `turn-end-idle` is Claude's own "waiting for your input" notice, given after a
 * minute at its prompt: a turn-end for a turn whose end no hook reported, and
 * nothing when the record already says the turn ended (its time stays the turn's).
 * Every hook's input is read from stdin (the script passes it, bounded). One that
 * carries `agent_id` is a subagent's event (a background or parallel subagent in
 * the same session): it writes nothing, because the main turn goes on. An input
 * that cannot be read as JSON is the main thread's, as for a tool clear. The idle
 * notice's input must also name `notification_type: "idle_prompt"`: Claude can run an entry for a notification
 * its matcher does not name, and no other notice means the turn ended. Claude
 * waits for a prompt's and a stop's hooks before it goes on, so those writes come
 * in the order of the turns; a notice is not waited for, which is why it only ever
 * closes an open turn. One that reads an open turn in the instant a new prompt is
 * submitted can still land after that prompt's start; the turn's own end repairs it.
 *
 * Claude Code fires no hook when a person interrupts a turn (Esc): neither Stop
 * nor, afterwards, the idle notice (Claude Code 2.1.332). The record then says
 * turn-start until the next prompt, and the kernel reads a Claude turn-start older
 * than 30 minutes as unknown.
 *
 * The write is whole: a temporary file beside the record (`turn.json.tmp-<pid>`,
 * a name the kernel's retire digest passes over, as it does over the record), then
 * a rename. It can never hurt the session: nothing is printed, every failure ends
 * quietly with status 0, and the script kills it at 2 s.
 */
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TURN_START = "turn-start";
export const TURN_END = "turn-end";
/** The hook action for Claude's idle notice. */
export const TURN_END_IDLE = "turn-end-idle";
/** A record larger than this is not one (the kernel's bound, lib/turn-activity.mjs RECORD_MAX). */
const RECORD_MAX = 4096;
/** The hook input is read up to this many bytes (the script hands at most as much). */
const INPUT_MAX = 65536;

export const turnPath = (home) => join(home, ".oats", "turn.json");

/** The record's event as it stands, or null: no file, not a regular file, too large, not a record. */
export function recordedEvent(home) {
  try {
    const path = turnPath(home), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > RECORD_MAX) return null;
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record !== null && typeof record === "object" && (record.event === TURN_START || record.event === TURN_END) ? record.event : null;
  } catch { return null; }
}

/** Whether a hook input (Claude's JSON, as text) is the idle notice. */
export function isIdleNotice(input) {
  try {
    const event = JSON.parse(input);
    return event !== null && typeof event === "object" && !Array.isArray(event) && event.notification_type === "idle_prompt";
  } catch { return false; }
}

/** Whether a hook input (Claude's JSON, as text) is a subagent's event: it carries `agent_id`,
 *  which only a subagent's does. One that is no JSON object is the main thread's. */
export function fromSubagent(input) {
  try {
    const event = JSON.parse(input);
    return event !== null && typeof event === "object" && !Array.isArray(event) && typeof event.agent_id === "string" && event.agent_id.length > 0;
  } catch { return false; }
}

/** The boundary an action writes, or null for none: `input` is the hook's input. A subagent's
 *  event writes none, and the idle notice writes a turn-end only over an open turn. */
export function boundaryOf(action, home, input = "") {
  if (fromSubagent(input)) return null;
  if (action === TURN_START || action === TURN_END) return action;
  if (action !== TURN_END_IDLE || !isIdleNotice(input)) return null;
  return recordedEvent(home) === TURN_START ? TURN_END : null;
}

/** Replace the home's record with `event` at `now()`. Whether it was written: false where the
 *  home's `.oats` is not a real directory (a link is never followed), or the write or the rename
 *  failed; no temporary file is left. */
export function writeTurn(home, event, { now = () => new Date() } = {}) {
  const path = turnPath(home), tmp = `${path}.tmp-${process.pid}`;
  try {
    if (!lstatSync(join(home, ".oats")).isDirectory()) return false;
    // A temporary file of this name is a dead writer's (the pid is ours now): replaced.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify({ event, at: now().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); }
    catch { /* left where it is: never read */ }
    return false;
  }
}

function main([action, home]) {
  if (typeof home !== "string" || !home.startsWith("/")) return;
  let input = "";
  try { input = readFileSync(0).subarray(0, INPUT_MAX).toString("utf8"); }
  catch { input = ""; /* no input to read: the main thread's, and not the idle notice */ }
  const event = boundaryOf(action, home, input);
  if (event) writeTurn(home, event);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch { /* a hook never fails the session */ }
  process.exitCode = 0;
}
