/**
 * Soul launch preferences (0.30, feature `launch-preference`; docs/design/2026-09-28-soul-launch-preference.md,
 * docs/desktop-cli-api.md "Launch preferences"). PURE: no I/O. A soul may declare `launch: {harness, model?}`;
 * a machine overrides it in oats-local.yaml `souls.launch` (a soul key or "*" → a launch configuration's name
 * or an inline {harness, model?}). For a NEW selection the first layer with a value decides: the flags, then
 * souls.launch.<key>, souls.launch."*", the soul's launch, the host default. A home's recorded launch stays
 * frozen: a plain start/restart never re-reads these layers (only --reselect-launch or a respawn does).
 */
import { oatsError } from "./errors.mjs";
import { REFUSED_TEXT, safeText } from "./refused-text.mjs";
import { shellWord } from "./shell-word.mjs";

export const LOCAL_FILE = "oats-local.yaml";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A coded error whose details also sit on `details` (the CLI boundary renders them). */
function fail(code, message, details) { const e = oatsError(code, message, details); e.details = details; return e; }
const pointerKey = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/** A preference value as `{harness, model}` (`model` null when absent); anything else → null. */
export function preferenceOf(v) {
  return isObject(v) && typeof v.harness === "string" ? { harness: v.harness, model: typeof v.model === "string" && v.model ? v.model : null } : null;
}

/** Where a soul's own `launch` lives: `<repoKey>:<path>/soul.yaml#/launch`, or `package:<id>:<path>/…` for a package soul. */
export function soulLaunchAt(entry) {
  const file = `${entry?.path ? `${entry.path}/` : ""}soul.yaml#/launch`;
  const pkg = typeof entry?.package === "string" ? entry.package : entry?.package?.id;
  return pkg ? `package:${pkg}:${file}` : `${entry?.repoKey ?? "?"}:${file}`;
}

/**
 * The layers a new selection reads, without flags: `declared` (the soul's own launch, or null) and `layer`
 * — the deciding one, `{ from: "local" | "local-default" | "soul", at, value }` (`value` a launch
 * configuration's name or `{harness, model}`) — or null (the host default).
 * `definition` is the soul.yaml content; `key` its soul key (soulKeyOf); `local` the oats-local.yaml value.
 * `offered` describes a read of the workspace (lib/instance-resolution.mjs soulsOffered): with it the
 * layers carry `unmatched`, the keys of souls.launch that name no soul (launchKeysUnmatched), so every
 * caller that has layers has that fact and none computes it; without it (a caller that made no read)
 * `unmatched` is empty. `key` travels too: a refusal names the soul it refused.
 */
export function launchLayers({ definition, entry, key, local, offered = null }) {
  const declared = preferenceOf(definition?.launch);
  const byKey = isObject(local?.souls?.launch) ? local.souls.launch : {};
  const pick = (k, from) => {
    if (!Object.hasOwn(byKey, k)) return null;
    const v = byKey[k];
    return { from, at: launchKeyAt(k), value: launchValueOf(v) };
  };
  const layer = (key !== undefined && key !== "*" ? pick(key, "local") : null) ?? pick("*", "local-default")
    ?? (declared ? { from: "soul", at: soulLaunchAt(entry), value: declared } : null);
  return { declared, layer, key: key ?? null, unmatched: offered ? launchKeysUnmatched({ local, offered }).unmatched : [] };
}

/**
 * The selection a NEW launch makes from the flags and the layers: `{ selection, preference, from, at }` for
 * resolveLaunchSelection. `--launch-config` or `--harness` decides (`from: "flag"`); otherwise the layer does
 * (a name selects that configuration; an inline or soul preference is `preference`), and `--model` alone
 * replaces only the model. No layer: the host default (`from: "host"`).
 */
export function selectionFrom({ flags = {}, layers }) {
  const selection = { launchConfig: flags.launchConfig, harness: flags.harness, model: flags.model };
  if (flags.launchConfig !== undefined || flags.harness !== undefined) return { selection, preference: null, from: "flag", at: null };
  const layer = layers?.layer;
  if (!layer) return { selection, preference: null, from: "host", at: null };
  if (typeof layer.value === "string") return { selection: { ...selection, launchConfig: layer.value }, preference: null, from: layer.from, at: layer.at };
  return { selection: { ...selection, launchConfig: "none" }, preference: { ...layer.value, from: layer.from }, from: layer.from, at: layer.at };
}

/** Where a key of souls.launch is: `oats-local.yaml#/souls/launch/<key>`, the key as a JSON pointer token. */
export const launchKeyAt = (key) => `${LOCAL_FILE}#/souls/launch/${pointerKey(key)}`;
/** An entry of souls.launch as an answer carries it: a launch configuration's name (or "none"), or
 *  `{harness, model}` (`model` null when it has none); null for no entry, or a value that is neither. */
export function launchValueOf(v) { return typeof v === "string" ? v : preferenceOf(v); }

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bareName = (key) => key.slice(key.lastIndexOf("/") + 1);
/** The edit distance between two names (insert, delete, replace), or `over` when it is more than `max`. */
function editDistance(a, b, max, over = max + 1) {
  if (Math.abs(a.length - b.length) > max) return over;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] > max ? over : row[b.length];
}
const SUGGESTIONS = 3, NEAR = 2;
/** The offered soul keys nearest to `key`, at most three: first those with its bare name (the part after
 *  the last `/`), then those whose bare name is within two edits, by distance then by code point. */
function nearestSoulKeys(key, offered) {
  const bare = bareName(key);
  const ranked = [];
  for (const k of offered) { const d = editDistance(bareName(k), bare, NEAR); if (d <= NEAR) ranked.push([d, k]); }
  return ranked.sort((a, b) => a[0] - b[0] || byCodepoint(a[1], b[1])).slice(0, SUGGESTIONS).map(([, k]) => k);
}

/**
 * THE function that decides which keys of souls.launch name no soul (awebai/oats#989): every reader asks it
 * and none computes the answer itself. `local` is the oats-local.yaml value. `offered` describes one read
 * of the workspace (lib/instance-resolution.mjs soulsOffered): `keys`, the soul key of every soul it
 * offers (a soul in souls.disabled included), and `unread`, what that read could not see:
 *   `all`: a reason when no key can be checked (the standalone view of a workspace whose host is unreadable);
 *   `bare`: a reason when a soul keyed by its bare name may be missing (a member unconfirmed, or a member
 *           or external soul skipped with a problem);
 *   `packages`: { <package id>: reason } for a package whose souls may be missing (declared and not
 *           locked, or locked with a soul skipped).
 * What a read did not record, it did not establish: a description with no `unread` (or soulsOffered's
 * "unrecorded", for a discovery that kept no record of what it skipped) leaves every key unchecked.
 * A key other than "*" that is the key of no offered soul is UNCHECKED when the source that could hold its
 * soul was not read, and UNMATCHED otherwise: `<member>/<soul>` among them, since a member's soul is keyed
 * by its bare name, and a key under a package that is locked and read. "*" is in neither.
 * → { unmatched: [{ key, at, value, suggestions }], unchecked: [{ key, at, value, reason }] }, by key.
 */
export function launchKeysUnmatched({ local, offered }) {
  const byKey = isObject(local?.souls?.launch) ? local.souls.launch : {};
  const keys = new Set(offered?.keys ?? []);
  const unread = isObject(offered?.unread) ? offered.unread : { all: "unrecorded" };
  const unmatched = [], unchecked = [];
  for (const key of Object.keys(byKey).sort(byCodepoint)) {
    if (key === "*" || keys.has(key)) continue;
    const row = { key, at: launchKeyAt(key), value: launchValueOf(byKey[key]) };
    const slash = key.lastIndexOf("/");
    const reason = unread.all ?? (slash < 0 ? unread.bare : Object.hasOwn(unread.packages ?? {}, key.slice(0, slash)) ? unread.packages[key.slice(0, slash)] : null) ?? null;
    if (reason !== null) unchecked.push({ ...row, reason });
    else unmatched.push({ ...row, suggestions: nearestSoulKeys(key, [...keys]) });
  }
  return { unmatched, unchecked };
}

/** Why a key of souls.launch was not checked, one sentence per reason launchKeysUnmatched can give
 *  (soulsOffered's): what `oats doctor` says after the key. */
export const LAUNCH_KEY_UNCHECKED = Object.freeze({
  standalone: "this deployment sees a standalone view (the workspace's host could not be read), so the workspace's souls are not known",
  unrecorded: "the read of the workspace kept no record of the souls it could not read, so it established nothing about this key",
  "member-unconfirmed": "a member of the workspace is not confirmed, and the key may be a soul of it",
  "soul-unread": "a member's or an external soul could not be read, and the key may be that soul's",
  "package-unlocked": "its package is declared and not locked (oats sync)",
  "package-soul-unread": "a soul of its package could not be read, and the key may be that soul's",
});

/** A key or a name from outside the kernel, as a sentence of a launch answer carries it: every character
 *  the kernel never prints (lib/refused-text.mjs REFUSED_TEXT) replaced. `safeText` and not `terminalText`:
 *  these sentences are put in an answer, which a client reads and refuses when it holds such a character;
 *  the exact key is the answer's data (`details.keys`, a row's `key`). A text the schemas admit is unchanged. */
const said = (text) => safeText(text, LAUNCH_PROBLEM_TEXT_MAX);
/** A key of souls.launch named in a sentence: quoted, through `said`. */
export const launchKeyQuoted = (key) => JSON.stringify(said(key));
/**
 * THE place the command an answer suggests is rendered (awebai/oats#1049): `oats soul launch set …` and
 * `oats soul launch remove …`, as a person pastes it. `set` pins `key`, or the placeholder `<soul>` when
 * the answer does not know which soul; `launch: "config"` offers a launch configuration only (the answers
 * about a configuration), otherwise a configuration or a harness. `remove` removes `key`, or `<key>`.
 * A key is a shell word (lib/shell-word.mjs): `"*"` prints as `'*'`, and every other key the schema of
 * oats-local.yaml admits prints as it is. The arguments in angle brackets are for the person to replace.
 * A key that holds a character the kernel never prints cannot be written into a command line: quoted it
 * would still carry the character, and with the character replaced the command would name another key.
 * For such a key there is no command, and what comes back says so and names the key (launchKeyQuoted)
 * and where it is removed by hand (awebai/oats#1064). The schema of oats-local.yaml admits no such key,
 * so a file never brings one here; a caller that hands one over still gets a text it can print. So no
 * sentence built with this function checks its key itself.
 */
export function soulLaunchCommand(action, { key, launch = "any" } = {}) {
  if (key !== undefined && REFUSED_TEXT.test(String(key))) {
    return action === "remove" ? `no command can name ${launchKeyQuoted(key)}: delete that key from ${LOCAL_FILE} (souls.launch) by hand` : `no command can name ${launchKeyQuoted(key)}, and no soul has such a key`;
  }
  if (action === "remove") return `oats soul launch remove ${key === undefined ? "<key>" : shellWord(key)}`;
  return `oats soul launch set ${key === undefined ? "<soul>" : shellWord(key)} --launch-config <name>${launch === "config" ? "" : " | --harness <h>"}`;
}
/** Whether souls.launch."*" is the layer that decided: the answers below then give its command first. */
const fromDefault = (from) => from === "local-default";

/** A launch configuration the layer names but this oats-local.yaml does not declare. */
export function launchConfigUnknown({ name, from, at }) {
  return fail("E_LAUNCH_CONFIG_UNKNOWN", `${at ?? "the launch preference"} names launch configuration ${JSON.stringify(name)}, which ${LOCAL_FILE} does not declare (launch-configs:); oats launch-config list shows what is`, { name, from, at });
}

/** The fix for it, by the layer that named the configuration: a soul's own entry, or souls.launch."*". */
export function launchConfigUnknownFix(name, from) {
  const declare = `declare launch configuration ${name} (oats launch-config set)`;
  if (fromDefault(from)) return `${declare}, name another for every soul without an entry (${soulLaunchCommand("set", { key: "*", launch: "config" })}), or pin the soul to one (${soulLaunchCommand("set", { launch: "config" })})`;
  return `${declare}, or pin the soul to another (${soulLaunchCommand("set", { launch: "config" })})`;
}

const NAMED = 10;
/** E_LAUNCH_CONFIG_AMBIGUOUS, or null: a new launch on `harness` that chose no configuration (`config`
 *  null after the harness default was looked up) although this host declares several for it and marks
 *  none `default: true`. A choice that asked for the bare harness (`--launch-config none`, or a
 *  souls.launch "none") is a choice; an inline or soul preference and `--harness` alone are not.
 *  Its fix names the flag and the pin of the soul; where souls.launch."*" chose the harness, the
 *  command for '*' too, before the soul's own. */
export function launchConfigAmbiguous({ launchConfigs = {}, harness, config, choice }) {
  if (config || (choice.selection.launchConfig === "none" && !choice.preference)) return null;
  const configurations = Object.keys(launchConfigs).filter((name) => launchConfigs[name]?.harness === harness).sort();
  if (configurations.length < 2) return null;
  const fix = `name one with --launch-config <name>, ${fromDefault(choice.from) ? `name one for every soul without an entry (${soulLaunchCommand("set", { key: "*", launch: "config" })}), ` : ""}pin the soul to one (${soulLaunchCommand("set", { launch: "config" })}), or mark one default: true (oats launch-config set)`;
  // The message names at most NAMED configurations, and fewer when it would otherwise pass a reader's
  // bound (the Desktop refuses a problem message over LAUNCH_PROBLEM_TEXT_MAX characters); details keep
  // the full list.
  const message = (count) => {
    const named = configurations.length > count ? [...configurations.slice(0, count), `and ${configurations.length - count} more`] : configurations;
    return `${LOCAL_FILE} declares ${configurations.length} ${harness} launch configurations (${named.join(", ")}) and none is default: true, and this launch names none; ${fix}`;
  };
  let count = NAMED;
  while (count > 1 && message(count).length > LAUNCH_PROBLEM_TEXT_MAX) count -= 1;
  return fail("E_LAUNCH_CONFIG_AMBIGUOUS", message(count), { harness, configurations, fix });
}

/** The code of the refusal below, and of every row that reports one of its keys (`oats souls`, `oats doctor`). */
export const LAUNCH_PREFERENCE_UNMATCHED = "E_LAUNCH_PREFERENCE_UNMATCHED";
/** The bound, in characters, of that refusal's `message` and of its `fix`, each: a reader's bound on a
 *  problem's texts (the Desktop's `Launch` reader refuses a longer one). */
export const LAUNCH_PROBLEM_TEXT_MAX = 1024;
const UNMATCHED_NAMED = 3;
export const UNMATCHED_FIX = `pin the soul each key was meant for (oats soul launch set), then remove the key (${soulLaunchCommand("remove")}); or name this launch with --launch-config <name> or --harness <h>`;
/** The unmatched keys in a sentence: at most `count` of them, each with its nearest soul keys when
 *  `near`, then "and K more". */
function unmatchedNamed(keys, count, near) {
  const shown = keys.slice(0, count).map((k) => `${launchKeyQuoted(k.key)}${near && k.suggestions.length ? ` (nearest: ${k.suggestions.map(said).join(", ")})` : ""}`);
  if (!shown.length) return `${keys.length} keys`;
  return keys.length > shown.length ? `${shown.join(", ")} and ${keys.length - shown.length} more` : shown.join(shown.length === 2 ? " and " : ", ");
}
/** The first of `render`'s wordings, from the fullest to the barest, that fits a reader's bound; the
 *  barest cut to it when a single name is longer than the bound allows. */
function boundedText(render) {
  for (const [count, near] of [[UNMATCHED_NAMED, true], [UNMATCHED_NAMED, false], [2, false], [1, false], [0, false]]) {
    const text = render(count, near);
    if (text.length <= LAUNCH_PROBLEM_TEXT_MAX) return text;
  }
  return `${render(0, false).slice(0, LAUNCH_PROBLEM_TEXT_MAX - 1)}…`;
}
/** One unmatched key as a problem row says it, within the same bound: the key and the nearest soul keys.
 *  `oats souls` read the workspace itself, and its row ends with the two commands, in their order.
 *  `lastRead` is `oats doctor`'s row, which read this machine's cache: it says that it speaks about this
 *  machine's last read of the souls and that a spawn is the authority (its remedy is the row's own field). */
export function unmatchedKeyMessage(row, { lastRead = false } = {}) {
  return boundedText((count, near) => {
    const named = `${LOCAL_FILE} souls.launch names ${count ? unmatchedNamed([row], 1, near) : "a key"}`;
    if (lastRead) return `${named}, which is no soul in this machine's last read of the souls this workspace offers. A spawn reads the workspace itself and is the authority: where it finds the same, a new launch of a soul with no entry of its own that names no launch is refused`;
    return `${named}, which is no soul this workspace offers: a new launch of a soul with no entry of its own that names no launch is refused while it is there. Pin the soul it was meant for (${soulLaunchCommand("set")}), then remove the key (${soulLaunchCommand("remove", count ? { key: row.key } : {})})`;
  });
}
/**
 * E_LAUNCH_PREFERENCE_UNMATCHED, or null (awebai/oats#989): a new launch that the fall-through would
 * decide (`choice.from` is neither the flags nor the soul's own souls.launch entry) while souls.launch
 * holds a key that names no soul the workspace offers (`layers.unmatched`). The kernel cannot tell which
 * soul such a key was meant to pin, so it cannot say that this launch is not the one: the launch is
 * refused, before the launch-configuration and harness refusals, which describe a launch that must not
 * be used at all. `--model` alone names no launch. `details`: { soul (the soul key refused), from, at
 * (the layer that would have decided), keys (every unmatched key, launchKeysUnmatched's rows), fix }.
 * The message names at most three keys and stays within LAUNCH_PROBLEM_TEXT_MAX, as `fix` does;
 * `details.keys` is complete.
 * The remedy's order is set, then remove: removing first leaves the soul on the fall-through.
 */
export function launchPreferenceUnmatched({ choice, layers }) {
  const keys = layers?.unmatched ?? [];
  if (!keys.length || choice.from === "flag" || choice.from === "local") return null;
  const message = unmatchedLaunchSaid({ choice, layers }, (count, one) => `it is refused, and nothing was created or started. Pin the soul ${one ? "it was" : "each was"} meant for (${soulLaunchCommand("set")}), then remove the key (${soulLaunchCommand("remove", count ? { key: keys[0].key } : {})}); or name this launch (--launch-config <name> or --harness <h>).`);
  return fail(LAUNCH_PREFERENCE_UNMATCHED, message, { soul: layers.key ?? null, from: choice.from, at: choice.at ?? null, keys, fix: UNMATCHED_FIX });
}
/** What the refusal above and a report of it both say, to `ending(count, one)`: the keys, that they name
 *  no soul, and which layer would decide a new launch of this soul that names none. */
function unmatchedLaunchSaid({ choice, layers }, ending) {
  const keys = layers.unmatched;
  const soul = layers.key === null || layers.key === undefined ? "this soul" : said(layers.key);
  const decider = choice.from === "local-default" ? `souls.launch."*"` : choice.from === "soul" ? "the soul's own launch" : "the host default";
  const one = keys.length === 1;
  return boundedText((count, near) => `${LOCAL_FILE} souls.launch names ${unmatchedNamed(keys, count, near)}, which ${one ? "is" : "are"} no soul this workspace offers. A new launch of ${count ? soul : "this soul"} that names no launch has no entry of its own, so ${decider} would decide it, and the kernel cannot tell which soul ${one ? "that key was" : "those keys were"} meant to pin: ${ending(count, one)}`);
}
/**
 * The `problem` of a `Launch` report for that refusal, or null where it would not be thrown: `{ code,
 * message, fix }`. A listing states the condition, where the refusal states what was refused: nobody
 * asked for a launch, so the message says that a new launch of this soul that names none would be
 * refused, in the refusal's own sentence up to there, and it does not end with the remedy, which is the
 * report's `fix` (UNMATCHED_FIX). Within the same bound; being shorter, it may name a key the refusal's
 * message had no room for.
 */
export function launchPreferenceUnmatchedProblem({ choice, layers }) {
  const refusal = launchPreferenceUnmatched({ choice, layers });
  if (!refusal) return null;
  return { code: refusal.code, message: unmatchedLaunchSaid({ choice, layers }, () => "it would be refused."), fix: refusal.details.fix };
}

/** The fix for a missing harness, by the layer that chose it: the flags, the soul's own entry of
 *  souls.launch, souls.launch."*", or the soul's own launch or the host default. */
export function harnessFix(harness, from) {
  if (from === "flag") return `install ${harness}, or choose another --harness / --launch-config`;
  if (from === "local") return `install ${harness}, or pin this soul to another launch (${soulLaunchCommand("set")})`;
  if (fromDefault(from)) return `install ${harness}, name another launch for every soul without an entry (${soulLaunchCommand("set", { key: "*" })}), or pin this soul to its own (${soulLaunchCommand("set")})`;
  return `install ${harness}, or pin this soul on this machine (${soulLaunchCommand("set")})`;
}
/** The layer that chose a launch, in words, for a message that has no room for its location. */
const LAYER_NAMED = Object.freeze({ flag: "the spawn flags", host: "the host default", local: "the soul's own entry of souls.launch", "local-default": `souls.launch."*"`, soul: "the soul's own launch" });
/** E_HARNESS_UNAVAILABLE: the chosen harness has no executable here. Never a fallback to another harness.
 *  The message says why, names the layer's location (`at`) and ends with the fix, whole. It stays within
 *  LAUNCH_PROBLEM_TEXT_MAX: a location too long for it (a repository key and a path, or a soul key) gives
 *  way to the layer's name, and then the reason is cut; `details.at` keeps the location. */
export function harnessUnavailable({ harness, from, at, why }) {
  const fix = harnessFix(harness, from);
  const named = LAYER_NAMED[from] ?? from;
  const message = (reason, source) => `${harness} is not installed on this machine (${reason}); ${source} chose it — ${fix}`;
  let text = message(why, from === "flag" || from === "host" ? named : at ?? from);
  if (text.length > LAUNCH_PROBLEM_TEXT_MAX) text = message(why, named);
  if (text.length > LAUNCH_PROBLEM_TEXT_MAX) text = message(`${String(why).slice(0, Math.max(0, LAUNCH_PROBLEM_TEXT_MAX - message("…", named).length))}…`, named);
  return fail("E_HARNESS_UNAVAILABLE", text, { harness, from, at: at ?? null, fix });
}

/** What a person can do about a harness its pane would not find. */
export const PANE_PATH_FIX = "declare the executable's absolute path in the launch configuration (executable), set PATH in the launch configuration (env), or start the OATS tmux server from your own shell (tmux -L oats new-session -d -s <session> -n hq), so that it has your PATH";
/** E_HARNESS_UNAVAILABLE for a harness looked up where its pane looks it up (the session's or the
 *  server's PATH, or a launch configuration's): `why` names that source and what went wrong, never
 *  the PATH's contents. Never a fallback to this process's PATH or to another harness. */
export function harnessNotOnPanePath({ harness, from, at, why }) {
  return fail("E_HARNESS_UNAVAILABLE", `${harness} is not available to its pane: ${why}, and a pane looks its harness up there; ${PANE_PATH_FIX}`, { harness, from, at: at ?? null, fix: PANE_PATH_FIX });
}

/** The closed `Launch` report: `{declared, effective: {harness, model, launchConfig}, from, at, problem}`. */
export function launchReport({ declared = null, harness, model = null, launchConfig = null, from, at = null, problem = null }) {
  return { declared: declared ? { harness: declared.harness, model: declared.model ?? null } : null, effective: { harness, model: model || null, launchConfig: launchConfig || null }, from, at: at ?? null, problem };
}

/** `modelFrom` for a model a preference layer supplied. */
export const MODEL_SOURCE = { soul: "soul preference", local: "local preference", "local-default": "local-default preference" };
