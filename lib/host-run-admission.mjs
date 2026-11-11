/** Private host-run child control, never an operator setting. A synchronous
 * tick cannot receive IPC/signals while it waits for a command, so each new
 * admission reads the fence the owning host run publishes before cancellation.
 * Outside its private bootstrap there is no fence and ordinary CLI rules hold. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { oatsError } from "./errors.mjs";

let fence = null;
const CHILD = fileURLToPath(new URL("./host-run-child.mjs", import.meta.url));
export function installHostRunFence(path) { fence = path; }
export function hostRunAdmissionOpen() {
  if (fence === null) return true;
  try { return readFileSync(fence, "utf8") === "open"; } catch { return false; }
}
export function assertHostRunAdmission() {
  if (!hostRunAdmissionOpen()) throw oatsError("E_HOST_RUN_FAILED", "host run is stopping; no further launch was admitted");
}
/** Carry control only across kernel-owned launches, via the private entrypoint.
 * No public flag or inherited environment variable gives another command control. */
export function hostRunChildArgs(bin, argv, group = false) { return fence === null ? [bin, ...argv] : [CHILD, bin, fence, group ? "group" : "member", ...argv]; }
