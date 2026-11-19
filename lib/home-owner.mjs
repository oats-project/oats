// The kernel acts on a home only as the home's owner (docs/trust-model.md, rule 3).
import { statSync } from "node:fs";
import { oatsError } from "./errors.mjs";

/** The `oats` command each claim verb is typed as. */
const COMMAND = Object.freeze({ start: "session start", resume: "session start --resume", stop: "instance stop", retire: "retire", upgrade: "instance upgrade" });

/** Refuse `verb` on the home of instance `name` when the effective user does not own it.
 *  A lifecycle verb runs what the home contains (its hooks, its harness, the Git of its
 *  repositories), so run as another user it would lend that user's authority to whoever can
 *  write the home. Root is no exception: it is the case that matters most.
 *  Nothing is checked where the platform has no user ids. A home that cannot be read is left
 *  to the verb's own refusals. Throws E_HOME_NOT_OWNED, with `details` { instance, home,
 *  owner, user } (the two uids); it is thrown before the verb writes anything. The fix it
 *  names keeps the owner's HOME (`sudo -H`): OATS keeps its own state under it. */
export function refuseHomeOfAnotherUser(verb, name, home, { euid = process.geteuid?.(), stat = statSync } = {}) {
  if (euid == null) return;
  let owner;
  try { owner = stat(home).uid; } catch { return; }
  if (owner === euid) return;
  const message = `Nothing was done: ${home} belongs to uid ${owner}, and this ${verb} of ${name} runs as uid ${euid}${euid === 0 ? " (root)" : ""}. `
    + "OATS acts on a home only as its owner, because it runs what the home contains; root is no exception. "
    + `Run the same command as that user, with that user's HOME: sudo -H -u '#${owner}' oats ${COMMAND[verb] ?? verb} …`;
  throw Object.assign(oatsError("E_HOME_NOT_OWNED", message), { details: { instance: name, home, owner, user: euid } });
}
