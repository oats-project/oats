/** The gate of a row menu's items for one field of an instance's own record (the renderer's side of
 * server/instance-record.mjs): Move to background / out of it (instance-background-menu.mjs) and Pin to top / Unpin
 * (instance-pin-menu.mjs). The gate is the route's own (`{ check: true }`, which runs nothing): this computer's CLI
 * lists the verb's feature and, for a remote row, so does its host.
 *
 * The menu is drawn synchronously on every roster paint, so the answer is held per deployment (a deployment is one
 * machine, so one host's features) and asked again once it is older than `ttlMs`, the held one staying in force
 * meanwhile. Until a deployment's first answer, and where the feature is missing, `gate` says it is not open (an
 * older OATS shows no item); a held answer that changes calls `onGate()`, for the caller to repaint. */
import { canAddressRemote } from "../../client/remote-address.mjs";

const HELD_MS = 60_000;

/**
 * @param {object} deps
 * @param {(row, body) => Promise<object>} deps.request  POST the verb's route for the row's deployment → its answer
 * @param {(row) => string} deps.deploymentOf  the row's deployment id (the route's ?ws=)
 * @param {string} deps.unavailable  the route's not-run code without the feature (E_INSTANCE_<VERB>_UNAVAILABLE)
 * @param {() => void} [deps.onGate]  a deployment's held answer changed: repaint
 */
export function createInstanceRecordGate({ request, deploymentOf, unavailable, onGate = () => {}, now = () => Date.now(), ttlMs = HELD_MS }) {
  const gates = new Map(); // deployment id -> { enabled: boolean|null, at, flight }
  const changed = () => { try { onGate(); } catch { /* a repaint must not break the gate */ } };
  /** Whether the row's deployment offers the items: true, false, or null (not known yet; a check was started). */
  function gate(row) {
    let key;
    try { key = deploymentOf(row); } catch { return null; }
    if (typeof key !== "string" || !key) return null;
    const held = gates.get(key) ?? { enabled: null, at: -Infinity, flight: null };
    gates.set(key, held);
    // Only a row the route can admit asks (a remote row its host reports addressable); its answer is the deployment's.
    if (!held.flight && now() - held.at >= ttlMs && typeof row?.home === "string" && canAddressRemote(row)) {
      const flight = held.flight = Promise.resolve().then(() => request(row, { instance: row.instance, home: row.home, check: true })).then(answer => {
        const enabled = answer?.status === "ok" && answer.check === true ? true
          : answer?.status === "not-run" && answer.reason?.code === unavailable ? false : held.enabled;
        return enabled;
      }, () => held.enabled).then(enabled => {
        if (held.flight !== flight) return;
        held.flight = null; held.at = now();
        if (enabled !== held.enabled) { held.enabled = enabled; changed(); }
      });
    }
    return held.enabled;
  }
  /** A write's answer: the feature is gone where it was held (a CLI or host changed), so the items go with the next
   * paint. Any other answer leaves the gate as it is. */
  function answered(row, answer) {
    if (answer?.status !== "not-run" || answer.reason?.code !== unavailable) return;
    const held = gates.get(deploymentOf(row));
    if (held && held.enabled !== false) { held.enabled = false; held.at = now(); changed(); }
  }
  return { gate, answered };
}
