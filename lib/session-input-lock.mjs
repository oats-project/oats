/** lib/session-input-lock.mjs — what serializes `oats session input` per tmux home (#2124), and
 *  the note of a paste that was never submitted.
 *
 *  Two inputs to one home at the same moment used to share one Enter: the second's paste landed
 *  between the first's paste and its Enter, the agent got the two texts as one message, and both
 *  callers read "verified". So an input to a tmux home holds this home's lock from before its paste
 *  to the end of its Enter's observation (lib/core.mjs inputInstanceSession). The lock is a claim
 *  (lib/dir-lock.mjs): a holder that was killed is taken over by the next input, never waited for.
 *
 *  What it does not cover: keys a person types in an attached terminal, another tool that types
 *  into the pane, and a home on a session provider, whose inputs the provider orders itself.
 *
 *  Both files are the kernel's own, outside every home (a home's baseline digests its files),
 *  beside the resume sweep's records. Dependency-free. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeKey, resumeStateDir } from "./session-seen.mjs";

/** How long an input waits for the input before it on the same home: that one's own budget (its
 *  commands, at most 2 s for the paste to settle and 1 s to look after the Enter, and the Enter of
 *  a paste left unsubmitted before it), with a margin. Past it the input is refused, nothing sent. */
export const INPUT_LOCK_WAIT_MS = 8000;

/** How long the note of a paste with no Enter is believed: past it the text is taken to be gone
 *  from the input line (a person at the terminal sent or deleted it meanwhile), and an Enter for
 *  it could answer whatever the pane shows by then. Long enough for the retry of an input whose
 *  sender died: a scheduled wake delivers again within a minute. */
export const UNSUBMITTED_MAX_AGE_MS = 2 * 60_000;

const fileOf = (home) => join(resumeStateDir(), "session-inputs", createHash("sha256").update(homeKey(home)).digest("hex").slice(0, 32));
/** The lock an input to `home` holds (lib/dir-lock.mjs withDirLock). */
export const inputLock = (home) => `${fileOf(home)}.lock`;

/** The note of `home`'s paste that has no Enter yet → `{ read, write, clear }`, for
 *  lib/session-input.mjs inputSessionTarget, which writes it once its paste is in the pane and
 *  clears it once its Enter is sent. A note that is still there when the next input holds the lock
 *  is a paste whose input died (or failed) before its Enter: the text is still in the agent's input
 *  line. `read` → `{ paneId, panePid, stale }`: the pane process the text was pasted to, and
 *  whether the note is older than UNSUBMITTED_MAX_AGE_MS (or its time cannot be read); or null (no
 *  note, or one that cannot be read: nothing is assumed from it). `write` and `clear` throw what
 *  the system throws: the caller decides what a note it could not keep costs. */
export function unsubmittedPaste(home) {
  const path = `${fileOf(home)}.pasted.json`, key = homeKey(home);
  return {
    read() {
      let doc;
      try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
      if (!doc || typeof doc !== "object" || doc.home !== key || typeof doc.paneId !== "string" || typeof doc.panePid !== "string") return null;
      const age = Date.now() - Date.parse(doc.at);
      return { paneId: doc.paneId, panePid: doc.panePid, stale: !(age >= 0 && age <= UNSUBMITTED_MAX_AGE_MS) };
    },
    write({ paneId, panePid }) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ home: key, paneId, panePid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
    clear() { rmSync(path, { force: true }); },
  };
}
