/** The resume cap of a home on a session provider (lib/session-providers.mjs;
 *  docs/execution-targets.md, "Lost sessions, and the resume"). A
 *  provider home's session that is gone, and that OATS did not stop, is a lost session, and whatever
 *  brings it back is a resume: the machine sweep's notice (`oats session resume`), `session start
 *  --resume`, and any input to it (a mail the broker delivers, a scheduled wake, a person's
 *  `session input`), since the provider restarts the session on that input. The cap is the kernel's
 *  own, counted here BEFORE the provider's input is called, so no path to the provider bypasses it:
 *  at most RESUME_LIMIT resumes of one home in RESUME_WINDOW_MS, in one boot, as the sweep bounds a
 *  tmux home's starts (lib/session-resume.mjs). At the cap the resume is refused
 *  E_SESSION_NOT_RUNNING, nothing is sent, and a mail stays unread.
 *
 *  One file per home under OATS_HOME_DIR (`session-resume/provider-resumes/<sha256 of the home's
 *  real path>.json`): `{ bootId, home, resumes: [<ISO time>] }`. Another boot's file counts
 *  nothing. Without a boot id (neither Linux nor macOS) nothing is counted, as for the sweep.
 *  Kernel-private, not a contract. A leaf: `session input` reads it without loading the sweep. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oatsError } from "./errors.mjs";
import { bootId, homeKey, resumeStateDir, sameBoot } from "./session-seen.mjs";

/** The resume notice of a home on a session provider: one line that asserts only what holds for
 *  every such instance, whatever ended its session. It is sent as the session's input. */
export const PROVIDER_RESUME_NOTICE = "OATS resumed this session after it was interrupted. Continue from where you were.";
/** At most this many resumes of one home in RESUME_WINDOW_MS. */
export const RESUME_LIMIT = 3;
/** The span over which a home's resumes are counted. */
export const RESUME_WINDOW_MS = 60 * 60_000;

const fileOf = (home) => join(resumeStateDir(), "provider-resumes", `${createHash("sha256").update(homeKey(home)).digest("hex").slice(0, 32)}.json`);
function readResumes(home, boot, now) {
  let doc;
  try { doc = JSON.parse(readFileSync(fileOf(home), "utf8")); } catch { return []; }
  if (!doc || typeof doc !== "object" || !sameBoot(doc.bootId, boot) || !Array.isArray(doc.resumes)) return [];
  return doc.resumes.filter((t) => typeof t === "string" && Number.isFinite(Date.parse(t)) && now - Date.parse(t) < RESUME_WINDOW_MS).sort();
}
function writeResumes(home, boot, resumes) {
  const path = fileOf(home), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(join(resumeStateDir(), "provider-resumes"), { recursive: true, mode: 0o700 });
  try { writeFileSync(tmp, JSON.stringify({ bootId: boot, home: homeKey(home), resumes }, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** How many resumes of `home` are counted now → `{ count, limit, nextAttemptAt }`: `nextAttemptAt`
 *  (an ISO time) when the cap is reached, the instant its oldest counted resume leaves the window. */
export function providerResumes(home, { boot = bootId(), now = Date.now() } = {}) {
  const resumes = boot ? readResumes(home, boot, now) : [];
  return { count: resumes.length, limit: RESUME_LIMIT, nextAttemptAt: resumes.length >= RESUME_LIMIT ? new Date(Date.parse(resumes[0]) + RESUME_WINDOW_MS).toISOString() : null };
}

/** Count one resume of the provider home `home`, before the provider's input is called → `{ undo }`:
 *  `undo()` takes the count back, only for an input the provider itself then refused (nothing was
 *  sent: a notice that was not sent is no resume). An input whose call failed, or answered outside
 *  the rules, keeps its count: the provider may have restarted the session on it. Throws E_SESSION_NOT_RUNNING at the cap, having counted nothing;
 *  `details.resumeCap` is `{ limit, windowMs, nextAttemptAt }`. `instance` names the home in the
 *  refusal. A count that cannot be written refuses the resume (E_SESSION_NOT_RUNNING too): an
 *  uncounted resume would be one the cap never sees. */
export function countProviderResume(home, instance, { boot = bootId(), now = Date.now() } = {}) {
  if (!boot) return { undo() {} };
  const resumes = readResumes(home, boot, now);
  if (resumes.length >= RESUME_LIMIT) {
    const nextAttemptAt = new Date(Date.parse(resumes[0]) + RESUME_WINDOW_MS).toISOString();
    throw Object.assign(oatsError("E_SESSION_NOT_RUNNING", `${instance} lost its session and was resumed ${resumes.length} times in the last hour, and was lost again each time: it is not resumed again before ${nextAttemptAt}, and nothing was sent. Start it by hand (oats session restart --home ${home}) if it should run`), { details: { resumeCap: { limit: RESUME_LIMIT, windowMs: RESUME_WINDOW_MS, nextAttemptAt } } });
  }
  const at = new Date(now).toISOString();
  try { writeResumes(home, boot, [...resumes, at]); }
  catch (e) { throw oatsError("E_SESSION_NOT_RUNNING", `${instance} lost its session, and its resume could not be counted (${e?.code ?? e?.message ?? e}); nothing was sent`); }
  return { undo() { try { const kept = readResumes(home, boot, now); const i = kept.lastIndexOf(at); if (i >= 0) { kept.splice(i, 1); writeResumes(home, boot, kept); } } catch { /* the count stands: a resume too many is counted, never one too few */ } } };
}
