/** Pinned instances (feature instance-pin; docs/desktop-cli-api.md "Pinned instances"): the one reading of the
 * kernel's answer to `oats instance pin`, for both clients. The Desktop's backend route reads it through its record
 * boundary (packages/desktop/server/instance-pin.mjs); the TUI's pin key runs the verb here (`pinInstance`).
 *
 * The kernel's answer is `{ instancePinApi: 1, instance, home, pinned, changed }`: one for another instance or
 * another home, or of another shape, is an unknown outcome, never a success. */
import { cliInstancePin } from './cli-adapter.mjs';
import { recordOutcome } from './instance-record-outcome.mjs';

/** The kernel's success for exactly the asked instance and home, as `{ status: 'ok', instance, pinned, changed }`;
 * else null. `asked`: `{ instance, home }`. */
export const pinAnswer = (r, asked) => r?.instancePinApi === 1 && r.instance === asked.instance && r.home === asked.home
  && typeof r.pinned === 'boolean' && typeof r.changed === 'boolean'
  ? { status: 'ok', instance: r.instance, pinned: r.pinned, changed: r.changed } : null;

/** What the command answered (instance-record-outcome.mjs): ok (pinAnswer), refused (an error the CLI printed) or
 * unknown. */
export const pinOutcome = (envelope, asked) => recordOutcome(envelope, result => pinAnswer(result, asked));

/** Pin or unpin one instance and read the answer: `oats instance pin <instance> on|off --home <home> (--dir <context>
 * | --server <server>) --json` (cli-adapter.mjs cliInstancePin, which refuses anything out of shape and runs
 * nothing). `args`: `{ instance, home, pinned, context | server }`; `io` as cliInstancePin's (`exec`, `cwd`). A call
 * that throws is an unknown outcome. */
export async function pinInstance(bin, args, io = {}) {
  let envelope;
  try { envelope = await cliInstancePin(bin, args, io); } catch { return { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }; }
  return pinOutcome(envelope, args);
}
