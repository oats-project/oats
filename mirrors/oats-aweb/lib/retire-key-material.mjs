// What a retire does with the aweb key material it leaves in a home
// (awebai/oats-aweb#318). A home the kernel keeps after a retire (--keep-dir,
// quarantined, or a failed retire) can be revived by a session provider with no
// OATS around it, and aw finds its identity at <cwd>/.aw or $AWEB_IDENTITY_HOME:
// so no answer of the retire hook leaves a credential entry at a path aw reads.
//
// - An exit 0 removes every credential entry: by then no remaining cleanup needs
//   the member key (a team_not_hosted handoff is key-independent).
// - A nonzero exit holds them: each is renamed, as itself, to
//   .oats-aweb/held/<name>, because the key is the only authority a retry has.
// - Every retire run restores held entries first, before it reads any state, so
//   a retry sees the home the failed retire saw. When an entry and its held copy
//   both exist (something re-created it, e.g. `aw init` in a revived session) or
//   a held entry cannot be read or renamed back, the retire fails closed and
//   touches neither.
//
// Renames only, within the home: nothing is copied, and a symlinked entry is
// moved or removed as the link itself, never followed (a retained seat's source
// identity, or one a person linked, is never touched). This stops a revived
// session from acting as the agent through aw's identity lookup; it is no
// boundary against a process of the same OS user that looks in .oats-aweb/held.
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The provider's credential entries in a home: aw's own identity home and
 *  every per-team or grant identity home the provider writes beside it. */
export const CREDENTIAL_ENTRY_RE = /^(?:\.aw|\.aweb-identity|\.aweb-identity-.+)$/;
export const HELD_RELATIVE = join(".oats-aweb", "held");
export const heldDir = (home) => join(home, HELD_RELATIVE);
/** Written by a retire that removed the entries (what it read from .aw, for its reruns). */
export const REMOVED_KEYS_RELATIVE = join(".oats-aweb", "removed-keys.json");

const codeOf = (e) => (/^E[A-Z]+$/.test(String(e?.code)) ? e.code : "error");
/** lstat that answers undefined for ENOENT and throws anything else. */
function lstatOrNone(path) {
  try { return lstatSync(path); }
  catch (e) { if (e?.code === "ENOENT") return undefined; throw e; }
}

/** Run `fn` with `home` writable by its owner: a home made read-only (by a person,
 *  or a tool) would otherwise keep every entry in it where aw reads it. Its mode is
 *  put back afterwards. When it can't be changed (another user's home), `fn` runs
 *  as it is and reports what it could not do. */
function withWritableHome(home, fn) {
  let mode;
  try { accessSync(home, constants.W_OK | constants.X_OK); }
  catch {
    try { mode = lstatSync(home).mode & 0o7777; chmodSync(home, mode | 0o300); }
    catch { mode = undefined; }
  }
  try { return fn(); }
  finally { if (mode !== undefined) { try { chmodSync(home, mode); } catch { /* the home stays owner-writable */ } } }
}

/** The credential entries directly in `home`, by name (a broken symlink included). */
export function credentialEntries(home) {
  return readdirSync(home).filter((name) => CREDENTIAL_ENTRY_RE.test(name)).sort();
}

/** The credential entries held in `home`'s .oats-aweb/held: `{ names }`, or
 *  `{ problem }` when the held directory is there and cannot be listed or is not
 *  a directory (a symlink included: it is never followed). */
export function heldEntries(home) {
  const dir = heldDir(home);
  let st;
  try { st = lstatOrNone(dir); }
  catch (e) { return { problem: `${dir} cannot be checked (${codeOf(e)})` }; }
  if (!st) return { names: [] };
  if (!st.isDirectory()) return { problem: `${dir} is not a directory` };
  try { return { names: readdirSync(dir).filter((name) => CREDENTIAL_ENTRY_RE.test(name)).sort() }; }
  catch (e) { return { problem: `${dir} cannot be read (${codeOf(e)})` }; }
}

/** Put every held entry back at its own name, all or none. `{ restored }` on
 *  success (an empty list when nothing was held), else `{ problem }` with every
 *  entry where it was found: nothing is renamed when any original path is taken
 *  or cannot be checked, and a rename that fails puts back the ones before it. */
export function restoreHeld(home) {
  return withWritableHome(home, () => restoreHeldNow(home));
}
function restoreHeldNow(home) {
  const held = heldEntries(home);
  if (held.problem) return { problem: held.problem };
  const dir = heldDir(home);
  const conflicts = [];
  for (const name of held.names) {
    const original = join(home, name), kept = join(dir, name);
    try { lstatSync(kept); }
    catch (e) { return { problem: `the held ${kept} cannot be read (${codeOf(e)})` }; }
    try { if (lstatOrNone(original)) conflicts.push(`${kept} and ${original}`); }
    catch (e) { return { problem: `${original} cannot be checked (${codeOf(e)}), so the held ${kept} was not put back` }; }
  }
  if (conflicts.length) return { problem: `both ${conflicts.join(", and both ")} exist: something re-created the entry a failed retire held` };
  const restored = [];
  for (const name of held.names) {
    try { renameSync(join(dir, name), join(home, name)); restored.push(name); }
    catch (e) {
      // Back to the held state this run found, so a revived session finds no key.
      const unwound = restored.filter((r) => { try { renameSync(join(home, r), join(dir, r)); return false; } catch { return true; } });
      return { problem: `the held ${join(dir, name)} could not be put back at ${join(home, name)} (${codeOf(e)})${unwound.length ? `; ${unwound.map((r) => join(home, r)).join(", ")} could not be held again and stay in place` : ""}` };
    }
  }
  return { restored };
}

/** Rename every credential entry of `home` into .oats-aweb/held, but one for which
 *  `keep(name)` answers a reason, which stays where it is. Each rename that fails
 *  leaves that entry in place and says why; nothing is thrown. */
export function holdEntries(home, { keep = () => undefined } = {}) {
  return withWritableHome(home, () => holdEntriesNow(home, { keep }));
}
function holdEntriesNow(home, { keep = () => undefined }) {
  const held = [], problems = [];
  let names;
  try { names = credentialEntries(home); }
  catch (e) { return { held, problems: [`${home} could not be listed (${codeOf(e)}), so no key material was held`] }; }
  const moving = [];
  for (const name of names) {
    const reason = keep(name);
    if (reason) problems.push(`${join(home, name)} stays in place: ${reason}`); else moving.push(name);
  }
  if (!moving.length) return { held, problems };
  const dir = heldDir(home);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (e) { return { held, problems: [...problems, ...moving.map((name) => `${join(home, name)} stays in place: ${dir} could not be created (${codeOf(e)})`)] }; }
  for (const name of moving) {
    const target = join(dir, name);
    try {
      // A rename onto an existing path would replace it: never overwrite a held entry.
      if (lstatOrNone(target)) { problems.push(`${join(home, name)} stays in place: ${target} already exists`); continue; }
      renameSync(join(home, name), target);
      held.push(name);
    } catch (e) { problems.push(`${join(home, name)} stays in place: it could not be moved to ${target} (${codeOf(e)})`); }
  }
  return { held, problems };
}

/** Remove one entry as itself: a directory recursively, anything else (a
 *  symlink included) by unlinking it. */
function removeOne(path) {
  const st = lstatOrNone(path);
  if (!st) return;
  if (st.isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}
/** Give the owner write and search on every directory under `path`, never
 *  following a symlink, so what is in a read-only directory can be removed. */
function ownerWritable(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return;
  chmodSync(path, (st.mode & 0o7777) | 0o700);
  for (const name of readdirSync(path)) ownerWritable(join(path, name));
}

/** Remove every credential entry of `home` (a symlink as the link itself) but one
 *  for which `keep(name)` answers a reason, which stays where it is, said so; and
 *  the held directory once it is empty. An entry that can't be removed, even
 *  once its directories are made owner-writable, is held instead, out of aw's
 *  reach; each one that is neither removed nor held is named, with why. */
export function removeEntries(home, { keep = () => undefined } = {}) {
  return withWritableHome(home, () => removeEntriesNow(home, { keep }));
}
function removeEntriesNow(home, { keep }) {
  const removed = [], heldInstead = [], problems = [];
  let names;
  try { names = credentialEntries(home); }
  catch (e) { return { removed, heldInstead, problems: [`${home} could not be listed (${codeOf(e)}), so its key material was not removed`] }; }
  for (const name of names) {
    const path = join(home, name);
    const reason = keep(name);
    if (reason) { problems.push(`${path} stays in place: ${reason}`); continue; }
    try { removeOne(path); removed.push(name); continue; }
    catch { /* a read-only directory: made writable below */ }
    let why;
    try { ownerWritable(path); removeOne(path); removed.push(name); continue; }
    catch (e) { why = codeOf(e); }
    const target = join(heldDir(home), name);
    try {
      mkdirSync(heldDir(home), { recursive: true, mode: 0o700 });
      if (lstatOrNone(target)) throw Object.assign(new Error("taken"), { code: "EEXIST" });
      renameSync(path, target);
      heldInstead.push(name);
      problems.push(`${path} could not be removed (${why}), so it was moved to ${target}, where aw doesn't look: remove it`);
    } catch (e) { problems.push(`${path} could not be removed (${why}) or moved to ${target} (${codeOf(e)}): aw can still use it there; remove it`); }
  }
  // An empty held directory is all a completed retry leaves of the hold.
  try { rmdirSync(heldDir(home)); }
  catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(e?.code)) problems.push(`${heldDir(home)} could not be removed (${codeOf(e)})`); }
  return { removed, heldInstead, problems };
}

/** A grant seat's grant homes in `home` (.aweb-identity, .aweb-identity-<digits>),
 *  by name: a grant's retry revokes through the resident's custody and never
 *  reads one. Only a grant seat has them: a joined team's numeric label can share
 *  the name, and grant seats join no teams. */
export function grantHomeEntries(home) {
  try { return credentialEntries(home).filter((name) => name === ".aweb-identity" || /^\.aweb-identity-\d+$/.test(name)); }
  catch { return []; }
}

/** Remove the named entries of `home` (a symlink as the link itself), made
 *  owner-writable first when they resist; `{ removed, problems }`. What stays is
 *  left for the caller to hold. */
export function removeNamed(home, names) {
  return withWritableHome(home, () => {
    const removed = [], problems = [];
    for (const name of names) {
      const path = join(home, name);
      try { removeOne(path); removed.push(name); continue; }
      catch { /* made writable below */ }
      try { ownerWritable(path); removeOne(path); removed.push(name); }
      catch (e) { problems.push(`${path} could not be removed (${codeOf(e)})`); }
    }
    return { removed, problems };
  });
}

/** Why a reader of `home`'s aweb identity (a start, a join or leave, mail,
 *  readiness) finds none because of a retire, or undefined: its entries are held
 *  by a retire that did not finish, or were removed by one that did. */
export function retiredKeysMessage(home, instance) {
  const held = heldEntries(home);
  if (held.problem || held.names.length) return `this home is being retired: its aweb keys are held in ${heldDir(home)} until \`oats retire ${instance || "<instance>"}\` finishes`;
  try { lstatSync(join(home, REMOVED_KEYS_RELATIVE)); } catch { return undefined; }
  let names;
  try { names = credentialEntries(home); } catch { return undefined; }
  return names.length ? undefined : "this home was retired and its aweb keys were removed, so it has no aweb identity: spawn a new instance instead";
}
