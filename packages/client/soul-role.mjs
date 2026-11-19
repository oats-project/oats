/** A soul's role, and the order souls are listed in, for every client (the Desktop's Souls grid and table, and
 * the Terminal UI later): maintainers, experts, developers, operations, then the rest, each alphabetical. (Not the
 * row's `soulKind`, which is where the soul comes from: member, package or external.)
 *
 * The kernel reports no role for a soul (oats-project/oats#1980 asks for one), so the role is read from the soul's
 * name, one rule:
 *   1. operations: any word of the name is setup, operator, operators, admin, ops or operations
 *      (`acme-oats-setup-expert`, `ops-admin`): a setup soul is operations even when it ends in -expert;
 *   2. else the last word: maintainer → maintainer, expert → expert, developer → developer;
 *   3. else other.
 * A word is a run of the name between `-`, `_`, `.` and `/`, case aside, so a package soul's qualified name
 * (`oats.engineering/code-reviewer`) reads the same as its bare one. The description is not read: a sentence
 * that says a soul "operates" something would misfile it, and the name is what the soul's author chose.
 *
 * A kernel `role` fact on the soul row would replace this rule (#1980): then `soulRole` reads it, and every client
 * keeps calling the same two functions.
 *
 *   soulRole(row)                -> 'maintainer' | 'expert' | 'developer' | 'operations' | 'other'
 *   SOUL_ROLES                   the roles, in list order
 *   SOUL_ROLE_WORDS              a role in words, singular ("developer"); the Desktop's Souls call it the soul's kind
 *   compareSoulsByRole(a, b)     list order: role, then name; for Array.prototype.sort
 *
 * No state, no DOM. */

export const SOUL_ROLES = Object.freeze(['maintainer', 'expert', 'developer', 'operations', 'other']);
export const SOUL_ROLE_WORDS = Object.freeze({ maintainer: 'maintainer', expert: 'expert', developer: 'developer', operations: 'operations', other: 'other' });
const OPERATIONS = new Set(['setup', 'operator', 'operators', 'admin', 'ops', 'operations']);
const LAST = Object.freeze({ maintainer: 'maintainer', expert: 'expert', developer: 'developer' });

const nameOf = row => typeof row === 'string' ? row : typeof row?.name === 'string' ? row.name : '';
const words = name => name.toLowerCase().split(/[-_./]+/).filter(Boolean);

/** The soul's role, from its name (a row with a `name`, or the name itself). */
export function soulRole(row) {
  const parts = words(nameOf(row));
  if (parts.some(part => OPERATIONS.has(part))) return 'operations';
  const last = parts.at(-1);
  return last !== undefined && Object.hasOwn(LAST, last) ? LAST[last] : 'other';
}

/** List order inside a group: the role's place in SOUL_ROLES, then the name. */
export function compareSoulsByRole(a, b) {
  return SOUL_ROLES.indexOf(soulRole(a)) - SOUL_ROLES.indexOf(soulRole(b)) || nameOf(a).localeCompare(nameOf(b));
}
