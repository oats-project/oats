// The holder a lock record names, and whether it is gone: one reading for the
// capture lock (its owner, its worker, its reclaim guard: capture-lock.mjs)
// and the stream lock (store.mjs). A record names its holder by pid, the boot
// it was taken in and the holder's process start, and is judged by the
// rule the kernel judges its cache write lock by (process-identity.mjs
// identityHolderState).
import { identityHolderState, namesIdentity, processStartToken, thisBoot } from "./process-identity.mjs";

export { namesIdentity };

export function validPid(pid) { return Number.isInteger(pid) && pid > 0 && pid <= 2147483647; }

/** What a record names its holder `pid` by beside the pid: this boot and the pid's start (null when it
 *  cannot be read). */
export const holderIdentity = (pid) => ({ bootId: thisBoot(), processStart: processStartToken(pid) });

const LIVENESS = { alive: "alive", gone: "dead", unknown: "unknown" };
/** "alive" | "dead" | "unknown" for the process a lock record names: identityHolderState in this
 *  package's words. One that names its boot or start is dead when taken in another boot, or when
 *  its pid is gone, runs with another start (a reused pid) or is a zombie; unknown when its start
 *  cannot be read. One that names neither is judged by its pid alone: dead when the pid is gone.
 *  A record without a process ID is unknown, whatever else it names. */
export function holderLiveness(holder) {
  return validPid(holder?.pid) ? LIVENESS[identityHolderState(holder)] : "unknown";
}
