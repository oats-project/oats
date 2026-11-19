import { chmodSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const IDENTITY_AUTHORITY = ["signing.key", "identity.yaml", "teams.yaml", "team-certs", "encryption.yaml", "encryption-keys"];
// Check the entire authority tree before any copy. Following a link could
// import unrelated files or change the source's permissions through the copy.
export function checkAuthorityEntry(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`symlink at ${path}; replace it with the real file at the source before seating`);
  if (st.isDirectory()) for (const name of readdirSync(path)) checkAuthorityEntry(join(path, name));
  else if (!st.isFile()) throw new Error(`non-regular authority entry at ${path}; replace it with a real file at the source before seating`);
  return st;
}
export function privateAuthorityModes(path) {
  const st = lstatSync(path);
  if (st.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) privateAuthorityModes(join(path, name));
  } else if (st.isFile()) chmodSync(path, 0o600);
  else throw new Error(`copied authority entry is not a regular file or directory: ${path}`);
}

/** The copied authority must contain only ordinary files/directories. Missing
 *  source material is reported by the existing retained-seat predicate. */
export function retainedAuthorityProblem(source) {
  try {
    let st;
    try { st = lstatSync(source); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    if (st.isSymbolicLink()) {
      let real;
      try { real = realpathSync(source); }
      catch { return `identity.source ${source} is a symlink; set identity.source to an existing real directory before seating`; }
      return `identity.source ${source} is a symlink; set identity.source to the real directory ${real} before seating`;
    }
    if (st.isDirectory()) for (const name of IDENTITY_AUTHORITY) {
      const path = join(source, name);
      try { lstatSync(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      checkAuthorityEntry(path);
    }
    return undefined;
  } catch (e) { return e.message; }
}
