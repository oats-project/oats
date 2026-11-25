/**
 * ui-prompt.mjs — a pi agent's question raises needs-input. pi has no question
 * dialog of its own: every blocking one is an extension's (`ctx.ui.select`,
 * `confirm`, `input`, `editor`, `custom`; a question tool's, say), and pi 0.84.4
 * and later fire `ui_prompt_start` and `ui_prompt_end` around it, in its terminal
 * UI and in RPC mode alike. The bridge holds a `question` claim between the two,
 * as oats.core does for Claude Code's dialogs, so the instance shows as needing
 * input and a scheduled wake holds its Enter. A pi before 0.84.4 fires neither
 * and reports nothing.
 *
 * pi coalesces nested and overlapping dialogs into one span, and the claim's text
 * is that span's title: the first dialog's, when it has one (`custom` has none).
 * pi does not wait for an event's handlers before it sends the next (it queues a
 * microtask each), so where an extension ahead of the bridge awaits in its start
 * handler, a dialog answered at once can reach the bridge end first. The count
 * keeps that pair from leaving a claim behind.
 */
import { claimMessage } from "./waiting-claim.mjs";

export function reportUiPrompt(pi, claim) {
  let open = 0;
  pi.on("ui_prompt_start", (event) => {
    open += 1;
    if (open > 0) claim.asked(claimMessage(event?.title));
  });
  pi.on("ui_prompt_end", () => {
    open -= 1;
    if (open <= 0) claim.asked(undefined);
  });
}
