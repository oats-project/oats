// The holder a lock record names, and whether it is gone: one reading for the
// capture lock (its owner, its worker, its reclaim guard: capture-lock.mjs)
// and the stream lock (store.mjs). A record names its holder by pid, the boot
// it was taken in and the holder's process start, and is judged by the
// kernel's rules for a claim's holder (process-identity.mjs).
import { existence, processLiveness, processStartToken, takenInAnotherBoot, thisBoot } from "./process-identity.mjs";

export function validPid(pid) { return Number.isInteger(pid) && pid > 0 && pid <= 2147483647; }

/** What a record names its holder `pid` by beside the pid: this boot and the pid's start (null when it
 *  cannot be read). */
export const holderIdentity = (pid) => ({ bootId: thisBoot(), processStart: processStartToken(pid) });

/** Whether a record names the boot it was taken in or its holder's start. */
export const namesIdentity = (holder) => "bootId" in holder || "processStart" in holder;

const LIVENESS = { alive: "alive", exists: "alive", gone: "dead", unknown: "unknown" };
/** "alive" | "dead" | "unknown" for the process a lock record names. One that names its boot or
 *  start is judged as the kernel judges a claim's holder (takenInAnotherBoot, processLiveness):
 *  dead when taken in another boot, or when its pid is gone, runs with another start (a reused
 *  pid) or is a zombie; unknown when its start cannot be read. One that names neither is judged
 *  by its pid alone (existence): dead when the pid is gone. A record without a process ID is unknown. */
export function holderLiveness(holder) {
  if (!validPid(holder?.pid)) return "unknown";
  if (!namesIdentity(holder)) return LIVENESS[existence(holder.pid).state];
  return takenInAnotherBoot(thisBoot())(holder) ? "dead" : LIVENESS[processLiveness(holder).state];
}
