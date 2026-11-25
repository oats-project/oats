/* The Automations row's failure mark (the Desktop UI rework, slice 1; slice 3d's words): the sidebar's pinned
   Automations row says how many failed after its name ("1 failed", also in its accessible name), and Home's tile shows
   a --danger dot, while any automation of the workspace failed its last run. Read from the
   kernel's own list answers (POST /api/automations { kind, action: "list" }, the read the Automations page makes), the
   existing `lastRun` facts only: no new field.

   A failed last run is a schedule's whose `lastRun.outcome` is one of FAILED_OUTCOMES, the producer's words for a run
   that didn't happen: `launch-failed` and `invalid`. A trigger's `lastRun` records a fire and carries no outcome, so a
   trigger never marks; `unknown` (a launch whose state isn't known), a missing `lastRun` and any other word don't
   either. */
import { automationRows } from "./automation-rows.mjs";

export const FAILED_OUTCOMES = Object.freeze(["launch-failed", "invalid"]);
/** Re-read at most this often per workspace (the roster's poll asks on every read). */
export const AUTOMATIONS_FAILURE_TTL = 60_000;
/** What Home's Automations tile says after its name: "Automations, 4, a run failed" (the sidebar's row says its
 * shown count instead, "Automations, 2 failed", slice 3d). */
export const FAILED_RUN_TEXT = ", a run failed";

/** Whether one automation row (automation-rows.mjs `automationRow`) failed its last run. */
export const lastRunFailed = (row) => row?.kind === "schedule" && FAILED_OUTCOMES.includes(row.lastRun?.outcome);

/** How many rows of the list answers failed their last run: `answers` is [[kind, json], …], an answer that isn't
 * a list (automationRows answers null) counting none. */
export function failedRuns(answers) {
  let count = 0;
  for (const [kind, json] of answers) count += automationRows(json, kind)?.rows.filter(lastRunFailed).length ?? 0;
  return count;
}

/** The mark's reader. `read(ws, kind)` resolves one list answer's `result` (the kernel's JSON) or rejects;
 * `supported()` says whether this OATS serves automations; `onChange(failed)` is told each change of the verdict
 * (true, false). `refresh(ws)` asks for the workspace on screen (null: none; the mark clears): a new workspace clears
 * the mark at once and reads; the same one re-reads once its last read is older than the TTL. Every read carries a
 * latest-intent token: an answer (or a failure) for a workspace no longer asked about, or overtaken by a newer read,
 * changes nothing. A failed read keeps the last verdict for its workspace. */
/** `onHost(name)`: the schedule list's `host.name`, this machine's name as the kernel reports it (oats-local.yaml
 * `host.name`), after each owned read that answers: the name, or null when the answer records none (so a name taken
 * away stops showing); a failed read hands on nothing and the last name stands. */
export function createAutomationsFailure({ read, supported = () => true, onChange = () => {}, onCount = () => {}, onHost = () => {}, now = () => Date.now(), ttl = AUTOMATIONS_FAILURE_TTL }) {
  let ws = null, failed = false, count = 0, readAt = -Infinity, serial = 0, inFlight = false;
  // The verdict, and how many rows failed (slice 3d: the row's "1 failed"); onCount is told each change of the count.
  const set = (n) => {
    const value = n > 0;
    if (value !== failed) { failed = value; onChange(value); }
    if (n !== count) { count = n; onCount(n); }
  };
  return {
    async refresh(next) {
      if (next !== ws) { ws = next; readAt = -Infinity; serial++; inFlight = false; set(0); }
      if (!ws || !supported()) { if (!ws) set(0); return; }
      if (inFlight || now() - readAt < ttl) return;
      const ticket = ++serial, asked = ws;
      inFlight = true;
      try {
        const answers = await Promise.all(["schedule", "trigger"].map(async (kind) => [kind, await read(asked, kind)]));
        if (ticket !== serial || asked !== ws) return;
        readAt = now(); set(failedRuns(answers));
        const host = automationRows(answers[0][1], "schedule")?.host?.name;
        onHost(typeof host === "string" && host ? host : null);
      } catch {
        // The last verdict stands; the next poll after the TTL asks again.
        if (ticket === serial && asked === ws) readAt = now();
      } finally {
        if (ticket === serial) inFlight = false;
      }
    },
    get failed() { return failed; },
    get count() { return count; },
  };
}
