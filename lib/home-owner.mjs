// The kernel acts on a home only as the home's owner (docs/trust-model.md, rule 3).
import { statSync } from "node:fs";
import { oatsError } from "./errors.mjs";

/** Refuse `verb` on the home of instance `name` when the effective user does not own it.
 *  A lifecycle verb runs what the home contains (its hooks, its harness, the Git of its
 *  repositories), so run as another user it would lend that user's authority to whoever can
 *  write the home. Root is no exception: it is the case that matters most.
 *  Nothing is checked where the platform has no user ids. A home that cannot be read is left
 *  to the verb's own refusals. Throws E_HOME_NOT_OWNED, with `details` { instance, home,
 *  owner, user } (the two uids); it is thrown before the verb writes anything. */
export function refuseHomeOfAnotherUser(verb, name, home, { euid = process.geteuid?.(), stat = statSync } = {}) {
  if (euid == null) return;
  let owner;
  try { owner = stat(home).uid; } catch { return; }
  if (owner === euid) return;
  const message = `Nothing was done: ${home} belongs to uid ${owner}, and this oats ${verb} of ${name} runs as uid ${euid}${euid === 0 ? " (root)" : ""}. `
    + "OATS acts on a home only as its owner, because it runs what the home contains; root is no exception. "
    + `Run it as that user: sudo -u '#${owner}' oats ${verb} …`;
  throw Object.assign(oatsError("E_HOME_NOT_OWNED", message), { details: { instance: name, home, owner, user: euid } });
}
