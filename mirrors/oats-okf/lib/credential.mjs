// oats.okf 6.2: the one place the library decides which credential a child
// process gets. With settings.oats.okf.github-token-file (host-only), every
// remote git call and every gh call uses the token in that file and nothing
// ambient; without it, the user's own git and gh login, as before 6.2. The
// mechanism is the publication helper's (`tokenEnv`), shared with the
// maintainer's `--token-file`, so proposer and maintainer cannot drift.
//
// A credential SOURCE is what this module hides: today a file; a brokered
// source arrives as its own setting, exclusive with this one, and changes
// only this module.
import { tokenEnv, readToken, hostRoutes } from '../skills/okf-authoring/scripts/okf-publication.mjs';
import { cleanEnv } from './io.mjs';
import { tokenFile, credentialRefusal } from './config.mjs';

/** `file` | `ambient`: which credential this deployment's knowledge calls use. */
export const credentialMode = (env = process.env) => tokenFile(env) === undefined ? 'ambient' : 'file';
/** A git child's environment. Reads no token: git asks the helper when a
 *  remote wants one, so local Git work never depends on the file. */
export function gitCredentialEnv(base, env = process.env) {
  const file = tokenFile(env);
  if (file === undefined) return base;
  try { return tokenEnv(base, file); }
  catch (e) { if (e?.code === 'E_CREDENTIAL') credentialRefusal(file, e.diagnostic?.reason); throw e; }
}
/** A gh child's environment. A bad token file refuses here (E_CREDENTIAL,
 *  naming the fix) before gh starts. A caller may be past a push by then
 *  (a delivery's PR step), so the refusal never claims nothing was sent. */
export function ghEnv(base, env = process.env) {
  const file = tokenFile(env);
  if (file === undefined) return base;
  try { return tokenEnv(base, file, { gh: true }); }
  catch (e) { if (e?.code === 'E_CREDENTIAL') credentialRefusal(file, e.diagnostic?.reason); throw e; }
}
/** After a remote Git failure: when the token file itself is the cause, say
 *  so with its fix instead of a bare authentication failure. */
export function refuseBadTokenFile(env = process.env) {
  const file = tokenFile(env);
  if (file === undefined) return;
  try { readToken(file); } catch (e) { if (e?.code === 'E_CREDENTIAL') credentialRefusal(file, e.diagnostic?.reason); throw e; }
}

/** What the host scan found, as one problem and its whole fix: the text of
 *  `setup --check`'s host-git line and of the refusal before a push. */
export function hostFinding({ routes = [], unread = [] } = {}) {
  const found = [...routes, ...unread.map(what => `${what} could not be read`)];
  const fixes = [...(routes.length ? ['remove each of them from the agents\' container (the token file is the one GitHub credential there), or remove settings.oats.okf.github-token-file to use this user\'s own login'] : []),
    ...(unread.length ? ['repair what could not be read, or make it readable by this user, so that it can be checked'] : [])];
  return found.length ? { detail: `Git on this host may not use the token in github-token-file: ${found.join('; ')}`, fix: fixes.join('; and ') } : null;
}
/** E_HOST_CREDENTIAL from the publication helper, with the whole fix. The
 *  helper refuses when a command starts, so nothing was sent by that command. */
export function hostRefusal(diagnostic) {
  const finding = hostFinding(diagnostic) ?? { detail: 'Git on this host may not use the token in github-token-file', fix: 'run oats okf setup --check for what answers for github.com on this host' };
  throw Object.assign(new Error(`${finding.detail}: ${finding.fix}`), { code: 'E_HOST_CREDENTIAL', fix: finding.fix });
}

/** The host scan, replaceable in tests only. */
export const hostProbe = { scan: (env = process.env) => hostRoutes(cleanEnv(env)) };
/** Before a push the library makes itself (a migration's delivery): with
 *  github-token-file, refuse E_HOST_CREDENTIAL while the host can answer
 *  GitHub in the token's place. Without the setting the host is not looked
 *  at. The publication helper applies the same gate to its own commands. */
export function refuseHostRoutes(env = process.env) {
  if (tokenFile(env) === undefined) return;
  const found = hostProbe.scan(env);
  if (found.routes.length || found.unread.length) hostRefusal(found);
}
