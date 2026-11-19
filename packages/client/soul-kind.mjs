/** A soul's kind, and the order souls are listed in, for every client (the Desktop's Souls grid and table, and
 * the Terminal UI later): maintainers, experts, developers, operations, then the rest, each alphabetical.
 *
 * The kernel has no fact for what a soul is for, so the kind is read from the soul's name, one rule:
 *   1. operations: any word of the name is setup, operator, operators, admin, ops or operations
 *      (`acme-oats-setup-expert`, `ops-admin`): a setup soul is operations even when it ends in -expert;
 *   2. else the last word: maintainer → maintainer, expert → expert, developer → developer;
 *   3. else other.
 * A word is a run of the name between `-`, `_`, `.` and `/`, case aside, so a package soul's qualified name
 * (`oats.engineering/code-reviewer`) reads the same as its bare one. The description is not read: a sentence
 * that says a soul "operates" something would misfile it, and the name is what the soul's author chose.
 *
 * A kernel `role` fact on the soul row would replace this rule: then `soulKind` reads it, and every client
 * keeps calling the same two functions.
 *
 *   soulKind(row)          -> 'maintainer' | 'expert' | 'developer' | 'operations' | 'other'
 *   SOUL_KINDS             the kinds, in list order
 *   SOUL_KIND_WORDS        a kind in words, singular ("developer")
 *   compareSouls(a, b)     list order: kind, then name; for Array.prototype.sort
 *
 * No state, no DOM. */

export const SOUL_KINDS = Object.freeze(['maintainer', 'expert', 'developer', 'operations', 'other']);
export const SOUL_KIND_WORDS = Object.freeze({ maintainer: 'maintainer', expert: 'expert', developer: 'developer', operations: 'operations', other: 'other' });
const OPERATIONS = new Set(['setup', 'operator', 'operators', 'admin', 'ops', 'operations']);
const LAST = Object.freeze({ maintainer: 'maintainer', expert: 'expert', developer: 'developer' });

const nameOf = row => typeof row === 'string' ? row : typeof row?.name === 'string' ? row.name : '';
const words = name => name.toLowerCase().split(/[-_./]+/).filter(Boolean);

/** The soul's kind, from its name (a row with a `name`, or the name itself). */
export function soulKind(row) {
  const parts = words(nameOf(row));
  if (parts.some(part => OPERATIONS.has(part))) return 'operations';
  return LAST[parts.at(-1)] ?? 'other';
}

/** List order inside a group: the kind's place in SOUL_KINDS, then the name. */
export function compareSouls(a, b) {
  return SOUL_KINDS.indexOf(soulKind(a)) - SOUL_KINDS.indexOf(soulKind(b)) || nameOf(a).localeCompare(nameOf(b));
}
