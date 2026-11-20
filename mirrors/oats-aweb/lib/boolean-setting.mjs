// The one reader of oats.aweb's boolean settings. `oats spawn --provider oats.aweb key=value`
// delivers every value as a string, so a boolean setting may arrive as true/false or as the
// strings "true"/"false". null reads as absent, so the default applies: an empty YAML value
// (`e2ee:`) is null. Anything else (another string, the empty one included, or a number) is
// refused, naming the setting, the accepted values and where it is set. Spawn, start and
// readiness read through it, so readiness reports the refusal the gate gives.

const ACCEPTED = 'must be true or false (the strings "true" and "false" are accepted too)';

/** `value` as a boolean, `fallback` when it is absent (undefined or null); throws the refusal otherwise. `where`
 *  names where the setting is set, the whole fix. */
export function booleanSetting(value, name, fallback, where) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} ${ACCEPTED}; ${where}; nothing was changed`);
}

const identityWhere = (name) => `set it under settings.oats.aweb.identity in oats-local.yaml, oats-workspace.yaml or the soul's soul.yaml, or pass \`--provider oats.aweb ${name}=true\` (or \`=false\`) to oats spawn; a home keeps the settings it was spawned with, so respawn it`;

/** identity.e2ee (default true) and identity.takeOver (default false), from the identity
 *  settings object; throws the refusal for the first that is neither a boolean nor its string. */
export function identityBooleans(identity) {
  const read = (key, fallback) => booleanSetting(identity?.[key], `identity.${key}`, fallback, identityWhere(`identity.${key}`));
  return { e2ee: read("e2ee", true), takeOver: read("takeOver", false) };
}
