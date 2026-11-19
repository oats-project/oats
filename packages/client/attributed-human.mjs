/** The owning human (feature spawn-attribution): a status row's `attributedHuman`, the label of the human
 * the instance's messaging identity is attributed to, or null (docs/desktop-cli-api.md, "Attributed human").
 * Read as the kernel gives it, under the contract's own rule for the label (a waiting claim's message rule,
 * waiting-on-you.mjs `waitingMessage`), on a local row and again on a remote row its host relayed. Anything
 * else (not a string, blank, a refused character, over 200 code points, or text withheld as unsafe) is null:
 * no human, never a fault, so a malformed value can't fail the row. Pure, never throws. */
import { waitingMessage } from './waiting-on-you.mjs';
import { EVENTS_WITHHELD } from './instance-events-contract.mjs';

export function attributedHumanData(v) {
  const label = waitingMessage(v);
  return label === EVENTS_WITHHELD || !label?.trim() ? null : label;
}
