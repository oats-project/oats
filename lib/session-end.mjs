/** How a launched home's last session ended (feature session-resume): `lost`, `stopped` or
 *  `exited`, derived from what the kernel already writes in the home. Kernel-private files, not a
 *  contract:
 *   - `.oats-start-exited`: the window a spawn or a start made writes it when the harness exits,
 *     `{"startId":"<id>","status":<n>}` (the harness's exit status). A kernel before 0.69 wrote the
 *     start id alone on one line, and only from a start's window.
 *   - `.oats-stop.json`: `oats instance stop` / `oats session stop`, a retire and a restart (before
 *     they end the session), `{ instance, at, stop, retained, startId }`; `startId` (0.69) is the
 *     start the stop ended, null when the home had none.
 *     A stop with the host (`oats host run` when the host stops: lib/host-run.mjs) writes the same
 *     record with `resume: true` and `reason: "host-stop"`, before it signals the harness: OATS
 *     ended that session only because the host was going down, and a resume brings it back.
 *  A reboot or a killed tmux server leaves neither file for the start that was running: that is a
 *  lost session, the one a resume brings back. Dependency-free: status, start --resume and the
 *  schedule runner read the files through here. */
import { join } from "node:path";
import { readFileHead } from "./bounded-read.mjs";
import { SESSION_END } from "./session-resume-contract.mjs";

export const START_EXITED_FILE = ".oats-start-exited";
export const STOP_RECEIPT_FILE = ".oats-stop.json";
/** `reason` in the stop record of a stop with the host. */
export const HOST_STOP_REASON = "host-stop";
const RECORD_MAX = 64 * 1024;
/** A shell's exit status from 128 up is a signal's (128 + n): the harness was killed, not ended. */
const SIGNALLED = 128;

function readText(path) {
  try {
    const { bytes, size } = readFileHead(path, RECORD_MAX + 1);
    return size > RECORD_MAX ? null : bytes.toString("utf8");
  } catch { return null; }
}

/** The exit marker of `home` → `{ startId, status }` (status null for the legacy one-line form), or
 *  null when there is none or it reads as neither form. Never throws. */
export function readStartExited(home) {
  const text = readText(join(home, START_EXITED_FILE));
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const v = JSON.parse(trimmed);
      if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.startId !== "string" || !v.startId) return null;
      return { startId: v.startId, status: Number.isInteger(v.status) && v.status >= 0 ? v.status : null };
    } catch { return null; }
  }
  // A start id as a start's pending receipt accepts one.
  return /^[a-zA-Z0-9-]{1,80}$/.test(trimmed) ? { startId: trimmed, status: null } : null;
}

/** The stop receipt of `home` (`.oats-stop.json`), or null. Never throws. */
export function readStopReceipt(home) {
  const text = readText(join(home, STOP_RECEIPT_FILE));
  if (text === null) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** When the home's current start began: the last restart's `startedAt`, else the spawn's `createdAt`;
 *  as ms, or NaN when the record names neither. */
export function currentStartTime(meta) {
  const restarts = Array.isArray(meta?.restarts) ? meta.restarts : [];
  const last = restarts.length ? restarts[restarts.length - 1]?.startedAt : undefined;
  return Date.parse(typeof last === "string" ? last : meta?.createdAt);
}

/** The stop record of `home` when it is of `meta`'s current start (`meta.startId`), else null: it
 *  names this start (`startId` equal), or, a record without a start id, was written after this
 *  start began. */
function stopOfCurrentStart(home, meta) {
  const startId = typeof meta?.startId === "string" && meta.startId ? meta.startId : null;
  const stop = readStopReceipt(home);
  if (!stop) return null;
  if (typeof stop.startId === "string" && stop.startId) return stop.startId === startId ? stop : null;
  return Date.parse(stop.at) > currentStartTime(meta) ? stop : null;
}

/** How the session of `meta`'s current start (`meta.startId`) ended, from the home's files alone:
 *   - `stopped`: the stop record is of this start (stopOfCurrentStart) and asks for no resume;
 *   - `lost`, whatever the exit marker says: the stop record is of this start and says
 *     `resume: true` (a stop with the host): the harness ended because the host did;
 *   - `exited`: the exit marker names this start with a status below 128, or in its legacy form
 *     (no status: a kernel before 0.69 wrote it only when the harness ended on its own window);
 *   - `lost`: anything else — a marker with a signal's status (128 and up), or no file naming this
 *     start (the host went down, or the tmux server died, under a live harness).
 *  A home that records no start id (spawned before 0.69, never restarted) can be named by no marker:
 *  only a stop after its `createdAt` reads `stopped`, otherwise `lost` (the documented legacy gap).
 *  The caller reads it only for a launched home that does not run. */
export function sessionEndOf(home, meta) {
  const startId = typeof meta?.startId === "string" && meta.startId ? meta.startId : null;
  const stop = stopOfCurrentStart(home, meta);
  if (stop) return stop.resume === true ? SESSION_END.LOST : SESSION_END.STOPPED;
  const exited = startId ? readStartExited(home) : null;
  if (exited && exited.startId === startId) return exited.status !== null && exited.status >= SIGNALLED ? SESSION_END.LOST : SESSION_END.EXITED;
  return SESSION_END.LOST;
}

/** Why the session of `meta`'s current start reads `lost`, where the home says: HOST_STOP_REASON
 *  for a stop with the host; null for every other loss, and for a session that is not lost. */
export function lostReasonOf(home, meta) {
  const stop = stopOfCurrentStart(home, meta);
  return stop?.resume === true && stop.reason === HOST_STOP_REASON ? HOST_STOP_REASON : null;
}

/** A current-start administrative stop's time, or null when the receipt cannot establish it.
 *  A future, pre-start or unreadable timestamp cannot relax the sweep's eligibility or budget. */
export function hostStoppedAt(home, meta, { now = Date.now() } = {}) {
  const stop = stopOfCurrentStart(home, meta);
  if (stop?.resume !== true || stop.reason !== HOST_STOP_REASON || typeof stop.at !== "string") return null;
  const at = Date.parse(stop.at), startedAt = currentStartTime(meta);
  return Number.isFinite(at) && Number.isFinite(startedAt) && at >= startedAt && at <= now ? at : null;
}
