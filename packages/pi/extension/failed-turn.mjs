/**
 * failed-turn.mjs — a turn that ends in a provider error stops the instance with
 * nothing left to run an instruction, so the bridge says so itself
 * (awebai/oats#1667): a waiting claim through the kernel's verb, as oats.core
 * does for Claude Code.
 *
 * agent_end is too early: pi retries a transient error and recovers an overflow
 * after it, and each attempt has its own agent_end. Only agent_settled (pi 0.80.4
 * and later) says pi will not go on, and a pi without it reports nothing. The last
 * run decides: a retry that worked leaves nothing to report, and an abort is not an
 * error, even one that cancels a retry's backoff, where no agent_end follows the
 * error it was retrying. The next run clears the claim, and a bridge's first run
 * clears what nobody alive holds: what an earlier pi in the session left
 * (waiting-claim.mjs). After that, a run with no claim to clear starts no process.
 * A run's end reaches the claim too, failed or not: that is when a live pi finds a
 * question a second pi left when it died inside the run (a nested one, a
 * subagent's), which no later event of this pi would otherwise clear.
 */
import { claimMessage } from "./waiting-claim.mjs";

export { MESSAGE_REFUSED } from "./waiting-claim.mjs";

/** The claim's message for a run's error: one the kernel accepts, whatever the provider said. */
export function failedTurnMessage(error) {
  const said = claimMessage(error);
  return said ? claimMessage(`Turn failed: ${said}`) : "Turn failed";
}

/** `claim`: the home's waiting claim (waiting-claim.mjs waitingClaim). */
export function reportFailedTurn(pi, claim) {
  let failure;
  pi.on("agent_start", () => {
    failure = undefined;
    claim.turnFailed(undefined);
  });
  pi.on("agent_end", (event) => {
    const last = event.messages?.findLast((message) => message.role === "assistant");
    failure = last?.stopReason === "error" ? failedTurnMessage(last.errorMessage) : undefined;
  });
  pi.on("agent_settled", (event) => {
    const reported = event.aborted ? undefined : failure;
    failure = undefined;
    claim.turnFailed(reported);
  });
}
