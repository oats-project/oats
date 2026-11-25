/** `automation` as a status row shows it (feature status-automation, oats-project/oats#2122 KP-16): the
 *  schedule or trigger whose tick made an instance, `{ kind, id, qualifiedId }`, recorded in instance.json
 *  at the spawn and read by one rule for a local row (lib/instance-listing.mjs), a remote one
 *  (lib/servers.mjs rowAutomation) and the spawn itself (lib/core.mjs). It is a LABEL, as `spawnedBy` is
 *  informational attribution: the tick's spawn passes `--made-by-automation`, which any process of the
 *  same user could pass, and no act reads it (no permission, lifecycle act, retire, wake or schedule
 *  decision). A client shows it as a label, never as proof. Dependency-free, so the remote status read
 *  loads nothing more for it. */

export const AUTOMATION_KINDS = Object.freeze(["schedule", "trigger"]);
/** One part of an automation's id: a schedule's or a trigger's bare id, or a workspace member's key.
 *  The characters and the length of the widest of them (lib/schedule.mjs SCHEDULE_ID_RE; a trigger's id
 *  may start with a dash, lib/automations.mjs AUTOMATION_ID_RE). */
const PART = "[A-Za-z0-9._-]{1,128}";
const QUALIFIED_RE = new RegExp(`^${PART}/${PART}$`);
const FLAG_RE = new RegExp(`^(schedule|trigger):(${PART}/${PART})$`);

/** `{ kind, id, qualifiedId }` when `value` is exactly that and no other key: a kind of AUTOMATION_KINDS,
 *  `qualifiedId` as `<scope>/<id>`, and `id` as the automations' lists give it: the qualified id, or the
 *  bare one of a local automation (`local/<id>`). Anything else (a hand-edited record, a remote host's
 *  answer) is null, never an error. */
export function readAutomation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("id") || !keys.includes("qualifiedId")) return null;
  const { kind, id, qualifiedId } = value;
  if (!AUTOMATION_KINDS.includes(kind) || typeof id !== "string" || typeof qualifiedId !== "string" || !QUALIFIED_RE.test(qualifiedId)) return null;
  return id === qualifiedId || qualifiedId === `local/${id}` ? { kind, id, qualifiedId } : null;
}

/** What `--made-by-automation <kind>:<qualifiedId>` names, `{ kind, qualifiedId }`, or null when it is
 *  not of that form. */
export function parseMadeByAutomation(text) {
  const m = typeof text === "string" ? FLAG_RE.exec(text) : null;
  return m ? { kind: m[1], qualifiedId: m[2] } : null;
}
/** The flag a tick's spawn carries for `kind` and `qualifiedId`, as one token. */
export const madeByAutomationFlag = (kind, qualifiedId) => `--made-by-automation=${kind}:${qualifiedId}`;
