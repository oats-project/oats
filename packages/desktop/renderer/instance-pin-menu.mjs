/** Pin to top / Unpin (feature instance-pin; docs/desktop-cli-api.md "Pinned instances"): the row context menu's
 * item (instance-actions.mjs draws it among the caller's own) and the palette's, and what running one does. The
 * write is the backend's (POST /api/instance-pin, server/instance-pin.mjs over `oats instance pin`); the server
 * re-reads the roster after a change or an unknown outcome, and the roster's order follows that read
 * (packages/client instance-tree.mjs: pinned first in its machine's list). Nothing here edits a row or moves one.
 *
 * Which item a row offers: Unpin on a row whose own `pinned` is true, Pin to top on any other. The labels are acts
 * with no dialog, so no ellipsis. A held or retiring row offers no item: instance-actions.mjs draws no caller item on
 * a blocked or limited row, and the palette asks `items` only for a row it can act on.
 *
 * The gate is the route's own (`{ check: true }`), held per deployment (instance-record-gate.mjs): until a
 * deployment's first answer, and where the feature is missing on this computer or on a remote row's host, no item
 * is offered; a held answer that changes calls `onGate()`, for the caller to repaint. */
import { serverLabel, shownLabel } from "../../client/remote-address.mjs";
import { displayLine, DETAIL_WITHHELD } from "../../client/display-text.mjs";
import { kernelLines } from "../../client/kernel-lines.mjs";
import { DESKTOP_TERMS } from "./desktop-terms.mjs";
import { createInstanceRecordGate } from "./instance-record-gate.mjs";

/** The menu's words for each item (an act at once: no dialog follows, so no ellipsis). */
export const PIN_LABELS = Object.freeze({ "pin-on": "Pin to top", "pin-off": "Unpin" });
export const PIN_UNAVAILABLE = "E_INSTANCE_PIN_UNAVAILABLE";

/** The item a row offers: Unpin on its own pin, Pin to top on any other row. */
export const pinOffer = instance => (instance?.pinned === true ? "pin-off" : "pin-on");

/** Why an answer to a write is not a success, as the menu's report detail; null when it is one (or the outcome is not
 * known: the roster re-read says what is true). */
export function pinFailure(answer, row, pinned) {
  if (answer?.status === "ok" && answer.check !== true && answer.instance === row.instance && answer.pinned === pinned) return null;
  if (answer?.status === "unknown") return null;
  const reason = answer?.reason;
  if (answer?.status === "refused" && typeof reason?.code === "string") return kernelLines(reason.message, undefined, DESKTOP_TERMS).join("\n") || reason.code;
  if (answer?.status === "not-run" && reason?.code === PIN_UNAVAILABLE) {
    return reason.details?.where === "server" ? `${shownLabel(serverLabel(row), true)}'s OATS can't pin instances yet.`
      : "Pinning an instance needs a newer OATS on this computer.";
  }
  const line = displayLine(reason?.message);
  return line && line !== DETAIL_WITHHELD ? line : "The answer was not one this Desktop reads.";
}

/**
 * @param {object} deps
 * @param {(row, body) => Promise<object>} deps.request  POST /api/instance-pin for the row's deployment → its answer
 * @param {(row) => string} deps.deploymentOf  the row's deployment id (the route's ?ws=)
 * @param {() => void} [deps.onGate]  a deployment's held answer changed: repaint
 */
export function createInstancePinMenu({ request, deploymentOf, onGate = () => {}, now = () => Date.now(), ttlMs }) {
  const { gate, answered } = createInstanceRecordGate({ request, deploymentOf, unavailable: PIN_UNAVAILABLE, onGate, now, ttlMs });
  return {
    gate,
    /** The menu's item for `row`, as instance-actions.mjs `extra` descriptors: none or one. */
    items(row) {
      if (gate(row) !== true) return [];
      const action = pinOffer(row);
      return [{ action, label: PIN_LABELS[action] }];
    },
    handles: action => Object.hasOwn(PIN_LABELS, action),
    /** Run the item: resolves with the answer on a success or an unknown outcome; throws with why on any other
     * (the menu's `report`: "<label> didn't finish for <name>.", the why as its detail). */
    async run(action, row) {
      if (!Object.hasOwn(PIN_LABELS, action)) throw new Error(`Unknown instance action "${action}"`);
      const pinned = action === "pin-on";
      const answer = await request(row, { instance: row.instance, home: row.home, pinned });
      const why = pinFailure(answer, row, pinned);
      if (why !== null) {
        // The feature is gone where it was held (a CLI or host changed): the item goes with the next paint.
        answered(row, answer);
        throw new Error(why);
      }
      return answer;
    },
  };
}
