/** lib/launch-choices.mjs — provider-declared launch choices (feature launch-choices; KP-14,
 *  oats-project/oats#2122): a choice a person makes for one launch (a reasoning level, a service
 *  tier) that only the session provider understands.
 *
 *  The kernel knows no choice's meaning. A session provider declares the names it takes
 *  (`sessionProviders.<name>.launchChoices`, lib/session-providers.mjs); `--launch-choice
 *  <name>=<value>` on `oats spawn`, `oats session start` and `oats session restart` gives a value;
 *  the kernel checks only that the home's provider declares the name, records the value in the
 *  home's launch recipe (`choices`), and hands the provider `choices: { <name>: <value> }` in the
 *  planned launch and the launch input, present only when one is chosen. A choice is refused or
 *  it reaches the launch: it is never dropped (resolveLaunchChoices).
 *
 *  No answer a client reads carries a recorded choice: the recipe an answer relays is made without
 *  them (lib/instance-listing.mjs redactLaunchRecipe). Kernel-private, dependency-free. */
import { oatsError } from "./errors.mjs";

/** A choice's name, as a provider declares it and a flag names it. */
export const LAUNCH_CHOICE_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** A choice's value: data for the provider, an argv element wherever a command line is made. */
export const LAUNCH_CHOICE_VALUE_RE = /^[a-z0-9_-]{1,40}$/;
/** At most this many choices: declared by one provider, and given to one launch. */
export const LAUNCH_CHOICES_MAX = 8;
/** The reserved value: `--launch-choice <name>=default` clears a recorded choice (the provider's own
 *  default then applies). It is never recorded and never passed to a provider. */
export const LAUNCH_CHOICE_DEFAULT = "default";
/** What a tmux home answers a launch choice. */
export const TMUX_TAKES_NO_CHOICES = "the tmux backend takes no launch choices yet; for pi, the model's own `:level` sets its thinking";

const bad = (message) => oatsError("E_BAD_ARGS", message);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The choices of one command line, from its `--launch-choice` values (each `<name>=<value>`) →
 *  `{ <name>: <value> }`, undefined when the flag is not given. Refused E_BAD_ARGS: a value that is
 *  not `<name>=<value>` in the two grammars, a name given twice, more than LAUNCH_CHOICES_MAX. */
export function launchChoicesOfFlags(values) {
  if (!values.length) return undefined;
  const out = {};
  for (const given of values) {
    const eq = typeof given === "string" ? given.indexOf("=") : -1;
    const name = eq > 0 ? given.slice(0, eq) : "", value = eq > 0 ? given.slice(eq + 1) : "";
    if (!LAUNCH_CHOICE_NAME_RE.test(name) || !LAUNCH_CHOICE_VALUE_RE.test(value)) throw bad(`--launch-choice takes <name>=<value> (a name of lowercase letters, digits and dashes, starting with a letter; a value of 1 to 40 lowercase letters, digits, underscores and dashes), got ${JSON.stringify(given === true ? "" : given)}`);
    if (Object.hasOwn(out, name)) throw bad(`--launch-choice names ${name} twice`);
    out[name] = value;
  }
  if (Object.keys(out).length > LAUNCH_CHOICES_MAX) throw bad(`--launch-choice is given ${Object.keys(out).length} times; at most ${LAUNCH_CHOICES_MAX} choices go to one launch`);
  return out;
}

/** Choices a caller of the library gives (`{ <name>: <value> }`), held to the flag's grammar. */
export function assertLaunchChoices(given) {
  if (given === undefined || given === null) return undefined;
  if (!isObject(given)) throw bad("launch choices are an object of <name>: <value>");
  return launchChoicesOfFlags(Object.entries(given).map(([name, value]) => `${name}=${value}`)) ?? {};
}

/** Whether a recipe's `choices` is what this kernel records: an object of at most LAUNCH_CHOICES_MAX
 *  entries in the two grammars, none the reserved value. A record that holds anything else is one
 *  this kernel cannot start from (lib/core.mjs assertLaunchRecipe): never read as far as it goes. */
export function recordedLaunchChoicesSound(held) {
  return isObject(held) && Object.keys(held).length <= LAUNCH_CHOICES_MAX
    && Object.entries(held).every(([name, value]) => LAUNCH_CHOICE_NAME_RE.test(name) && typeof value === "string" && LAUNCH_CHOICE_VALUE_RE.test(value) && value !== LAUNCH_CHOICE_DEFAULT);
}
/** The choices a recorded recipe holds: `{ <name>: <value> }`, {} for a recipe from before the
 *  feature or with no choice. (A recipe is asserted sound before it is read: assertLaunchRecipe.) */
export function recordedLaunchChoices(recipe) {
  return isObject(recipe?.choices) && recordedLaunchChoicesSound(recipe.choices) ? { ...recipe.choices } : {};
}

/** The choices one launch carries → `{ <name>: <value> }` (empty: none), or a refusal: REFUSE, NEVER
 *  DROP. E_BAD_ARGS, before anything is created, stopped or started (`nothing`: the clause that
 *  says so for this command).
 *    recorded   the home's recorded choices (recordedLaunchChoices), {} at a spawn
 *    given      this command's `--launch-choice` values (launchChoicesOfFlags), undefined when none
 *    declared   the names the home's session provider declares (`{ <name>: { description } }`), or
 *               null on tmux, which takes none
 *    who        the instance, for the sentence; `backend`: the provider's name; `capability`: its capability
 *  A given value replaces the recorded one of that name; the reserved value `default` clears it and
 *  goes nowhere. Then every choice that is left must be one the provider declares:
 *  - a name this command gives and the provider does not declare is refused, naming what it declares;
 *  - on tmux any choice given is refused with tmux's own sentence;
 *  - a RECORDED choice the provider no longer declares (another backend at a restart, a provider
 *    release that dropped the name) is refused with the way to clear it: never started without it. */
export function resolveLaunchChoices({ recorded = {}, given, declared, who, backend = "tmux", capability = null, nothing }) {
  const tail = nothing ? `; ${nothing}` : "";
  const asked = given ?? {};
  const live = Object.entries(asked).filter(([, value]) => value !== LAUNCH_CHOICE_DEFAULT);
  if (declared === null && live.length) throw bad(`${who} cannot take --launch-choice ${live.map(([n, v]) => `${n}=${v}`).join(", ")}: ${TMUX_TAKES_NO_CHOICES}${tail}`);
  const names = declared ? Object.keys(declared) : [];
  const said = capability ? `${capability}'s session provider ${backend}` : `session backend ${backend}`;
  const offers = names.length ? `it declares ${names.join(", ")}` : "it declares none";
  for (const [name, value] of live) if (!names.includes(name)) throw bad(`${who} cannot take --launch-choice ${name}=${value}: ${said} declares no launch choice ${name} (${offers})${tail}`);
  const choices = { ...recorded };
  for (const [name, value] of Object.entries(asked)) { if (value === LAUNCH_CHOICE_DEFAULT) delete choices[name]; else choices[name] = value; }
  const stale = Object.keys(choices).filter((name) => !names.includes(name));
  if (stale.length) {
    const why = declared === null ? TMUX_TAKES_NO_CHOICES : `${said} no longer declares ${stale.length === 1 ? "it" : "them"} (${offers})`;
    throw bad(`${who} records the launch choice${stale.length === 1 ? "" : "s"} ${stale.map((n) => `${n}=${choices[n]}`).join(", ")}, and ${why}. Clear ${stale.length === 1 ? "it" : "them"} with ${stale.map((n) => `--launch-choice ${n}=${LAUNCH_CHOICE_DEFAULT}`).join(" ")}${tail}`);
  }
  if (Object.keys(choices).length > LAUNCH_CHOICES_MAX) throw bad(`${who} would carry ${Object.keys(choices).length} launch choices; at most ${LAUNCH_CHOICES_MAX} go to one launch${tail}`);
  // (In the provider's order of declaration: one launch's choices read the same whatever the order of the flags.)
  return Object.fromEntries(names.filter((name) => Object.hasOwn(choices, name)).map((name) => [name, choices[name]]));
}
