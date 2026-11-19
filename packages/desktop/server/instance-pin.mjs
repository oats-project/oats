/** Whether an instance is pinned (feature instance-pin; docs/desktop-cli-api.md "Pinned instances"), through the
 * kernel verb `oats instance pin <instance> on|off`: the only writer of the home's pin. A pin only orders the roster
 * (pinned first in its machine's list, packages/client instance-tree.mjs rowPinned); it is the home's, so everyone
 * who views that machine sees it. The row's context menu and the palette offer Pin to top / Unpin
 * (renderer/instance-pin-menu.mjs).
 *
 * The boundary is instance-record.mjs's, shared with `oats instance color` and `oats instance background`: this
 * module is the verb's descriptor. A remote row's pin is set on its host, with `--server`, as `oats instance stop`
 * is routed.
 *
 * Request (POST /api/instance-pin?ws=<id>, a bounded JSON object):
 *   { instance, home, pinned }         pinned: true (on) or false (off)
 *   { instance, home, check: true }    nothing runs: whether the pin can be set here (the menu asks before it offers)
 * Answer (instance-record.mjs):
 *   { status: 'ok', instance, pinned, changed }         the kernel's answer for exactly that instance and home
 *   { status: 'ok', instance, check: true }
 *   { status: 'refused', reason: { code, message } }    the kernel's refusal (E_SESSION_UNKNOWN, E_INSTANCE_RETIRING,
 *                                                       E_LIFECYCLE_BUSY, E_REMOTE_INCOMPATIBLE from a host without
 *                                                       the feature, …)
 *   { status: 'unknown', reason: { code } }
 *   { status: 'not-run', reason: { code, message, details? } }   E_BAD_ARGS, E_WORKSPACE_UNKNOWN, E_SNAPSHOT_UNKNOWN,
 *                                                       E_BUSY, E_INSTANCE_PIN_UNAVAILABLE (details.where `local`
 *                                                       or `server`, as for the colour)
 *
 * The kernel's answer is `{ instancePinApi: 1, instance, home, pinned, changed }`: one for another instance or
 * another home is an unknown outcome, never a success (packages/client instance-pin.mjs pinAnswer, the one reading). */
import { cliInstancePin } from '../../client/cli-adapter.mjs';
import { PIN_FEATURE } from '../../client/instance-tree.mjs';
import { pinAnswer, pinOutcome } from '../../client/instance-pin.mjs';
import { createInstanceRecordBoundary, recordNotRun } from './instance-record.mjs';

export const INSTANCE_PIN_FEATURE = PIN_FEATURE;
/** Nothing ran: this boundary's own reasons, each its fixed sentence. */
export const instancePinNotRun = recordNotRun({
  E_BAD_ARGS: 'This pin request was not valid.',
  E_WORKSPACE_UNKNOWN: 'This window\'s workspace is not one this computer serves.',
  E_SNAPSHOT_UNKNOWN: 'This computer\'s roster no longer lists this instance.',
  E_INSTANCE_PIN_UNAVAILABLE: 'This OATS can\'t pin an instance.',
  E_BUSY: 'Another window is pinning this instance. Try again.',
});

/** What the command answered, as the renderer reads it: the shared reading (packages/client instance-pin.mjs
 * pinOutcome), the TUI's too. */
export const instancePinOutcome = pinOutcome;

const PIN_VERB = Object.freeze({ field: 'pinned', valid: v => typeof v === 'boolean', feature: INSTANCE_PIN_FEATURE,
  unavailable: 'E_INSTANCE_PIN_UNAVAILABLE', notRun: instancePinNotRun, invoke: cliInstancePin, answer: pinAnswer });

/** `getContext()` → { workspace, cli, instances, localCwd }, as the colour's. */
export const createInstancePinBoundary = ({ invoke = cliInstancePin } = {}) => createInstanceRecordBoundary(PIN_VERB, { invoke });
export const instancePinRequest = createInstancePinBoundary();
