/** lib/turn-activity.mjs — the turn fact (feature status-activity): whether a running agent works on a
 *  turn now or waits at its prompt. `activity` on `oats status --json` instance rows and on `oats server
 *  roster --json` rows: `"working"` (the harness started a turn that has not ended), `"idle"` (its last
 *  turn ended and no new one started) or `null` (OATS cannot tell). Display only: no act reads it.
 *
 *  Two sources, one per backend, and neither can go stale:
 *  - a tmux home: `<home>/.oats/turn.json`, the last turn boundary the harness's own hooks wrote
 *    (oats.core's Claude Code hooks, the @awebai/oats-pi bridge; nothing for Codex, whose notify hook
 *    reports turn ends only), `{ "event": "turn-start" | "turn-end", "at": "<ISO>" }`, replaced whole
 *    (a temporary file, then a rename). It is read only for a row whose harness is observed live
 *    (`running: true`) and counts only from the row's `startedAt`: a start begins only after the
 *    previous harness is proven gone, so no earlier session's hook writes after it, and a record from
 *    before it is the last session's.
 *  - a provider home: the provider's own answer at that read (`activity` in its inspect result,
 *    lib/session-providers.mjs judgeInspect). The file is never read there, though the pi bridge
 *    writes it in every home: on a provider home only the provider's answer counts.
 *
 *  The file is in the agent's home, and in full mode its user can write any file there: a record
 *  written by hand gives a wrong label and nothing else. So the read takes a regular file only, under
 *  a real `.oats` directory, without following a link, up to RECORD_MAX bytes, and whatever is not a
 *  record reads `null`, never an error. A leaf: the status read loads it without core.mjs. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";

export const ACTIVITY = Object.freeze({ WORKING: "working", IDLE: "idle" });
const ACTIVITIES = new Set(Object.values(ACTIVITY));
/** The two boundaries a record names. */
export const TURN_EVENT = Object.freeze({ START: "turn-start", END: "turn-end" });
/** The record's place in a home, kernel-owned (under `.oats/`). */
export const TURN_FILE = join(".oats", "turn.json");
/** A record larger than this is not one. */
export const RECORD_MAX = 4096;
/** How long a Claude Code turn that started and wrote no end reads `"working"`. Claude Code fires no
 *  hook when a person interrupts a turn (Esc): neither Stop nor, afterwards, its idle notice (probed
 *  at Claude Code 2.1.332), so the turn's start would stand until the next prompt. Past this the row
 *  reads `null`: OATS cannot tell a long turn from an interrupted one. */
export const CLAUDE_OPEN_TURN_MAX_MS = 30 * 60 * 1000;

/** A row's `activity` as a provider or another kernel gave it, by this kernel's own rule → the value
 *  (`"working"`, `"idle"` or `null`), or undefined when it is not one. */
export function readActivity(value) {
  return value === null || ACTIVITIES.has(value) ? value : undefined;
}

/** A tmux home's turn fact → `"working"`, `"idle"` or `null`. `startedAt`: the row's (the current
 *  start's instant); `harness`: the home's; `now`: the read's instant, in ms. `null` for: no file, a
 *  file that is not a regular one of at most RECORD_MAX bytes, bad JSON, a record without a known
 *  `event` or an `at` that is an instant, a row with no `startedAt`, a record from before it, and a
 *  Claude Code turn-start older than CLAUDE_OPEN_TURN_MAX_MS. A record's other keys are not read.
 *  Never throws. */
export function tmuxActivity(home, { startedAt, harness = null, now = Date.now() } = {}) {
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started)) return null;
  let record;
  try {
    // `.oats` itself must be the home's own directory: a link there is never followed.
    if (!lstatSync(join(home, ".oats")).isDirectory()) return null;
    const { bytes, size } = readFileHead(join(home, TURN_FILE), RECORD_MAX + 1);
    if (size > RECORD_MAX) return null;
    record = JSON.parse(bytes.toString("utf8"));
  } catch { return null; }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const at = typeof record.at === "string" ? Date.parse(record.at) : NaN;
  if (!Number.isFinite(at) || at < started) return null;
  if (record.event === TURN_EVENT.END) return ACTIVITY.IDLE;
  if (record.event !== TURN_EVENT.START) return null;
  if (harness === "claude" && now - at > CLAUDE_OPEN_TURN_MAX_MS) return null;
  return ACTIVITY.WORKING;
}
