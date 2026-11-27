// A pi launch names a model, and bb's pi must be able to resolve it (the pi model check).
//
// bb takes any model id at `bb thread spawn`, answers a thread, and resolves the id only
// when the thread starts: an id it cannot resolve leaves a thread in error behind a spawn
// that answered a thread id. So the id is checked here, before anything is started.
//
// The rule is bb's own, no stricter (bb-app 0.50.1, provider-pi's resolvePiModel, over the
// models pi itself reports: pi 1.5.2's get_available_models): an id that is exactly one
// model's `<provider>/<id>` is that model; otherwise it is a bare id, and the one model
// with that id; two or more with it is refused, none is refused. Nothing is matched
// loosely: no prefix, no pattern, no other case.
//
// What is read is `bb provider models pi --json`: a list of {id, routeProviderId, …}, `id`
// being `<provider>/<id>` and `routeProviderId` the provider. bb lists fewer models than
// it resolves, so "not listed" proves "pi has none" only where the list is whole for the id:
//   - a model whose id ends in a date (-YYYYMMDD) is held back, and listed only where it is
//     named exactly, as `<provider>/<id>`, with --selected-model (which every read here
//     does). One named by its bare id stays held back;
//   - where pi's own configuration narrows the models it offers (`enabledModels`), bb
//     lists only those, and a thread still starts on any other model pi has. bb's pi
//     keeps the narrowing it started with, so the settings must also be older than bb;
//   - a home with a pi configuration of its own (`<home>/.pi`) may add models for its
//     thread alone (bb resolves in the thread's directory, and lists from its own).
// (The first two seen against bb-app 0.50.1 and pi 1.5.2: such a model starts a thread and
// is not in the list. lib/pi-config.mjs piListMayBePartial says when the list is whole.) In those cases, and wherever the list cannot be read, nothing is refused:
// the launch goes on as it did before this check, with a warning. Two listed models with
// the id are two models whatever else is held back, so that refusal stands there (but for
// an id with a slash, which may be a held-back model's exact `<provider>/<id>`). One
// listed and a second held back passes here, and bb refuses it at the thread's start.
//
// And bb's list may be OLDER than pi's configuration: bb's server serves a list it fetched
// for a minute as it is. Where that configuration changed a moment ago, neither refusal is
// given (lib/pi-config.mjs piListMayBeOld). Two cases are left, which nothing shows: where
// bb's refresh of its list fails, bb serves the list it kept, of any age, and a model added
// to pi since is refused until bb's next good refresh; and where one of pi's files was
// removed a moment ago (a provider, a login), the two-provider refusal may name a provider
// pi no longer has, for a minute. So every refusal says the way out.
import { isObject } from "./errors.mjs";

export const PI_MODEL_REFUSED = "E_BACKEND_LAUNCH_ARG";
export const PI_MODEL_UNCHECKED = "session-provider-pi-model-unchecked";
// A model id bb holds back from its list (its isModelAlias, negated): dated, and not "-latest".
const DATED = /-\d{8}$/;
const WHY_MAX = 200;

/** "A and B", "A, B and C" (`last`: the word before the last name). */
const listed = (names, last = "and") => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names[names.length - 1]}`);
const brief = (text) => { const line = String(text).split("\n")[0].trim(); return line.length > WHY_MAX ? `${line.slice(0, WHY_MAX - 1)}…` : line; };

/** bb's list as [{id, provider, bare}], or null where a row cannot be read as one of pi's
 *  models: its `<provider>/<id>` and the provider that begins it. A row with an id and no
 *  provider at all is a model a person added to bb's own list (bb's customModels), not one
 *  pi reports: bb's pi resolves among pi's own models only, so such a row says nothing of
 *  what a thread can start on. It is left out, and the rest still reads. */
function rowsOf(value) {
  if (!Array.isArray(value)) return null;
  const rows = [];
  for (const row of value) {
    if (!isObject(row) || typeof row.id !== "string" || row.id === "") return null;
    if (row.routeProviderId === undefined || row.routeProviderId === null) continue;
    if (typeof row.routeProviderId !== "string" || row.routeProviderId === "") return null;
    const prefix = `${row.routeProviderId}/`;
    if (!row.id.startsWith(prefix) || row.id.length === prefix.length) return null;
    rows.push({ id: row.id, provider: row.routeProviderId, bare: row.id.slice(prefix.length) });
  }
  return rows;
}

// The way out of a refusal that rests on a list bb kept too long (above).
const RETRY = "try again in a minute";

/** What bb's list says of the model. `partial`: why the list may not be all the models the
 *  thread can start on, or null (lib/pi-config.mjs piListMayBePartial). `old`: why it may
 *  be older than pi's configuration, or null (piListMayBeOld).
 *  → { ok: true } | { refused: <sentence> } | { unchecked: <short why> }. */
export function piModelVerdict(model, value, { partial = null, old = null } = {}) {
  const rows = rowsOf(value);
  if (rows === null) return { unchecked: "the list is not one this provider can read" };
  if (rows.some((row) => row.id === model)) return { ok: true };
  const serving = rows.filter((row) => row.bare === model);
  if (serving.length === 1) return { ok: true };
  if (serving.length > 1) {
    if (old !== null) return { unchecked: old };
    // An id with a slash may also be the exact `<provider>/<id>` of a model the list holds
    // back, which bb takes before it looks at bare ids: where the list may not be whole,
    // two listed models with that bare id do not show that bb would find it ambiguous.
    if (partial !== null && model.includes("/")) return { unchecked: partial };
    return { refused: `pi model ${JSON.stringify(model)} is served by ${listed(serving.map((row) => row.provider))}: use ${listed(serving.map((row) => row.id), "or")} (if you just changed that in pi, ${RETRY})` };
  }
  if (rows.length === 0) return { unchecked: "the list is empty" };
  if (old !== null) return { unchecked: old };
  if (partial !== null) return { unchecked: partial };
  // Any id that ends in a date, with a slash or without: a bare id may itself hold a slash,
  // so one that looks like `<provider>/<id>` may be a held-back model's bare id.
  if (DATED.test(model)) return { unchecked: "a model whose id ends in a date is not always listed" };
  return { refused: `pi has no model ${JSON.stringify(model)} (if you just added it to pi, ${RETRY})` };
}

/** The check of one launch's model: one read of bb's list. `bb`: a client (lib/bb.mjs).
 *  → null (the model passes), { problem: {code, message, status} } (refused: nothing may
 *  be started), or { warning: {code, message} } (it could not be checked: the launch goes
 *  on). Never throws for anything bb did or did not answer. */
export async function piModelFinding(model, bb, { partial = null, old = null } = {}) {
  const unchecked = (why) => ({ warning: { code: PI_MODEL_UNCHECKED, message: `could not check the model ${JSON.stringify(model)} against pi's model list: ${brief(why)}` } });
  const answer = await bb.piModels(model);
  if (!answer.ok) return unchecked(answer.timedOut ? "no answer in time" : answer.message);
  // bb answers a list it kept where it could not load pi's models, and says so beside it,
  // on a line of its own among whatever else it wrote there.
  const notLoaded = (answer.said ?? "").split("\n").find((line) => /could not load models/i.test(line));
  if (notLoaded !== undefined) return unchecked(notLoaded);
  const verdict = piModelVerdict(model, answer.value, { partial, old });
  if (verdict.ok) return null;
  if (verdict.unchecked !== undefined) return unchecked(verdict.unchecked);
  return { problem: { code: PI_MODEL_REFUSED, message: verdict.refused, status: "needs-configuration" } };
}

/** Whether a launch's `model` is one to check: a model id, as the launch itself takes one. */
export const isModelId = (model) => typeof model === "string" && model !== "" && !model.startsWith("-");
