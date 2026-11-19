/** Ambient aw selectors never choose an OATS child's principal or service.
 *  A call that deliberately supplies an input names it in `explicit` after
 *  stripping the shared list. Stricter callers may pass a smaller base. */
export const AW_UNSET_ENV = Object.freeze([
  'AWEB_IDENTITY_HOME', 'AWEB_URL', 'AWEB_API_KEY',
  'AWEB_ROLE_NAME', 'AWEB_ROLE', 'AWID_REGISTRY_URL',
]);

export function awChildEnv(base = process.env, explicit = {}) {
  const env = {...base, AW_NO_UPDATE_CHECK: '1'};
  for (const name of AW_UNSET_ENV) delete env[name];
  return {...env, ...explicit};
}
