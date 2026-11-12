// Launch settings the Desktop no longer reads, and the line main prints at startup for each one a
// launch still sets, so a script that sets it is told rather than ignored without a word. Nothing here
// reads a setting's value: a retired setting is named only to say it is ignored. main.mjs names none of
// them itself (backend-inventory.test.mjs holds main free of a TCP port).

const RETIRED = Object.freeze([
  ["OATS_DESKTOP_PORT", "the backend listens on a private socket the app makes for it (see docs/desktop.md, Security posture)"],
]);

/** The notices for the retired settings `env` sets, to any value (an empty one included), in a fixed order. */
export function retiredSettingNotices(env) {
  return RETIRED.filter(([name]) => env?.[name] !== undefined)
    .map(([name, why]) => `oats-desktop: ${name} is no longer used and is ignored: ${why}`);
}
