import { HERDR_REMOVED } from "./terminal-contract.mjs";
import { requireTerms } from './client-terms.mjs';
import { SOUL_COLORS } from './soul-colors.mjs';

export function runtimeState(instance) {
  return instance.running === true ? "running" : instance.running === false ? "stopped" : "unknown";
}

const RUNTIME_ORDER = Object.freeze({ running: 0, unknown: 1, stopped: 2 });
/** The panel's runtime order, a comparator for `sort`: running, then unknown (`running` null or anything not
 * a boolean: it may be running, so it stands above the rows nobody needs to watch), then stopped; by name
 * within each. Each row's place depends on that row alone, so it is a total order whatever `running` holds.
 * Read by `panelInstances` (deployment-panel.mjs). The sidebar's roster orders by spawn time, newest first
 * (instance-tree.mjs `rosterOrder`). */
export function byRuntimeState(a, b) {
  return RUNTIME_ORDER[runtimeState(a)] - RUNTIME_ORDER[runtimeState(b)] || String(a.instance).localeCompare(String(b.instance));
}

/** Which colour an instance's row shows (feature instance-color, awebai/oats#1421 §2): the row's own `color`
 * when it is a palette name exactly (soul-colors.mjs SOUL_COLORS, which the kernel's INSTANCE_COLORS equals),
 * else null, and null draws the row as it looks without one. The one rule every client draws by: the kernel
 * already validated what it relays, and anything else a row carries is no colour. Colour never says a
 * state alone: a client's mark keeps the state by its shape. */
export function instanceColor(row) {
  const color = row?.color;
  return typeof color === 'string' && SOUL_COLORS.includes(color) ? color : null;
}

/** The words for an instance's siblings (#1312; the list `instanceSiblings` answers, instance-tree.mjs):
 * null for none, else `sibling of a`, `sibling of a and b`, `sibling of a, b and c`, the names in the
 * order given. The same in every client. */
export function siblingText(siblings) {
  const names = (siblings || []).map((s) => s.instance);
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `sibling of ${list}`;
}

/** The stand-in `unsupportedSession` writes for an older kernel's Herdr row: the one text of a row that is
 * this home's own sentence. Not on the stable surface. */
export const HERDR_STAND_IN = `E_HERDR_REMOVED: ${HERDR_REMOVED}`;

/** The row carries the kernel's own reason for a removed session backend, which `unsupportedSession` answers as it is. */
const kernelsOwnReason = (instance) => instance?.runtimeState === "unsupported" && typeof instance.runtimeError === "string" && !!instance.runtimeError;

/** Why a kernel-reported row has no usable session, or null. A Herdr-recorded
 * instance cannot open, start or restart; it can still retire. A 0.31 kernel
 * reports it as runtimeState "unsupported" with its E_HERDR_REMOVED text; an
 * older kernel only records a sessionTarget (local) or a herdr backend
 * (remote), and its runtimeError is a Herdr probe's, so the stem stands in. */
export function unsupportedSession(instance) {
  const stem = HERDR_STAND_IN;
  if (instance?.runtimeState === "unsupported") return kernelsOwnReason(instance) ? instance.runtimeError : stem;
  return (instance?.sessionTarget !== undefined && instance?.sessionTarget !== null) || instance?.backend === "herdr" ? stem : null;
}

/** Who wrote what `unsupportedSession` answers for a row as the kernel or a host reported it: "kernel"
 * for the row's own text, null for the stand-in written here (and for a row it answers null for). Asked
 * where the text is chosen (liveness.mjs, remote-roster.mjs), of the reported row: a panel's row already
 * holds the chosen text as its `runtimeError`, stand-in included, and its speaker in `runtimeErrorOrigin`.
 * Not on the stable surface. */
export const unsupportedSessionOrigin = (instance) => (kernelsOwnReason(instance) ? "kernel" : null);

/** The speakers a text of a row can have, as `runtimeErrorOrigin` and a reason's `origin` name them, each
 * with the words a client puts in front of the text (`originLead`):
 *
 *   kernel          read from a kernel answer: this machine's OATS, or another host's OATS relayed by it.
 *                   A client names both the same; a row's `serverUnreached` says which read the text is about.
 *   terminal-probe  made by the client's terminal check (liveness.mjs, tmux-status.mjs): a sentence of
 *                   its own, or the message of a failed `tmux` or `ps` run
 *   roster-read     made by the client while it read the roster of other machines (remote-roster.mjs)
 *
 * A text with no speaker (the stand-in above) has no key. The marks are written here, in the shared home,
 * at the place that chooses the text, and never taken from an answer: a key a kernel, a host or the
 * liveness collector sent is dropped on every path.
 *
 * A reason's `origin` has one more value, "unattributed", with no words: remote-address.mjs `rowReason`
 * writes it for a row's text that reached it beside no speaker. It names nobody, so it is not in this
 * table, `originLead` answers null for it, and it is never a row's `runtimeErrorOrigin` nor a kept
 * failure's `errorOrigin`. */
const LEADS = Object.freeze({
  kernel: () => "OATS says:",
  "terminal-probe": (terms) => `${terms.name}'s terminal check says:`,
  "roster-read": (terms) => `${terms.name}'s read of other machines says:`,
});
/** Whether a value is one of the three speakers. Not on the stable surface. */
export const knownOrigin = (value) => typeof value === "string" && Object.hasOwn(LEADS, value);

/** The words a client puts in front of a text to name who made it, or null when `origin` is not one of
 * the three speakers (absent, or any other value). It takes a row's `runtimeErrorOrigin`, a reason's
 * `origin` (remote-address.mjs `rowReason`, instance-acts.mjs) or a kept failure's `errorOrigin`: all hold
 * the same values. A client writes nothing of its own there, so two clients name a speaker the same way.
 *
 *   kernel          "OATS says:"                                  no term: the word the other sentences use
 *   terminal-probe  "<name>'s terminal check says:"               `terms.name` (client-terms.mjs)
 *   roster-read     "<name>'s read of other machines says:"
 *
 * The two checks name the client: the kernel's own text can be about a terminal server too, so "the
 * terminal check" alone would not say whose check it was. A text with no lead is shown as the client's
 * own words always were: never under "OATS says:". A reason's "unattributed" is such a value: no words.
 * `terms` is required, also where no term is used. */
export function originLead(origin, terms) {
  requireTerms(terms, "originLead");
  return knownOrigin(origin) ? LEADS[origin](terms) : null;
}
/** Whether a row has a `runtimeError`: a string that is not empty. Only such a row carries `runtimeErrorOrigin`. */
export const hasRuntimeError = (row) => typeof row?.runtimeError === "string" && !!row.runtimeError;
/** The speaker of a row's own `runtimeError`, or null: the row's `runtimeErrorOrigin` when the row has a
 * text and the key names one of the three. The key is a panel row's, set by the shared home
 * (deployment-panel.mjs, remote-roster.mjs). Not on the stable surface. */
export const runtimeErrorSpeaker = (row) => (hasRuntimeError(row) && knownOrigin(row.runtimeErrorOrigin) ? row.runtimeErrorOrigin : null);

export function runtimeCounts(instances) {
  const counts = { running: 0, stopped: 0, unknown: 0 };
  for (const instance of instances) counts[runtimeState(instance)]++;
  return counts;
}
