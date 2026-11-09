/**
 * `oats soul launch set|remove` (feature `soul-launch`, awebai/oats#990; docs/desktop-cli-api.md
 * "`oats soul launch`"): the supported writer of oats-local.yaml `souls.launch`, a soul's launch preference
 * on this machine (lib/launch-preference.mjs). It writes the key a soul has (soulKeyOf), so it cannot
 * write a key that names no soul; `remove` also takes the exact text of a key in the file, the remedy
 * for a key that names none, and that form works when the workspace's souls cannot be read.
 * The file is rewritten through the path `oats teams` writes it by (lib/local-edit.mjs): one entry set
 * or deleted in the parsed document, every other entry kept with its value and its comments.
 */
import YAML from "yaml";
import { oatsError } from "./errors.mjs";
import { editLocal, readLocal } from "./local-edit.mjs";
import { LOCAL_FILE, launchKeyAt, launchKeysUnmatched, launchLayers, launchValueOf } from "./launch-preference.mjs";
import { findSoulEntry, qualifiedSoulName, soulCandidates, soulsOffered } from "./instance-resolution.mjs";
import { soulKeyOf } from "./teams.mjs";
import { LAUNCH_HARNESSES, launchConfigsAt, launchReportFor } from "./core.mjs";

export const SOUL_LAUNCH_API = 1;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(code, message, details) { const e = oatsError(code, message, details); e.details = details; return e; }
const isRefusal = (e) => typeof e?.code === "string" && e.code.startsWith("E_");
const launchOf = (local) => (isObject(local?.souls?.launch) ? local.souls.launch : {});
const NAMED = 10;
const named = (list) => (list.length > NAMED ? [...list.slice(0, NAMED), `and ${list.length - NAMED} more`] : list).join(", ");

/** The entry `set` writes, from its flags: a launch configuration's name (`none` included), or the inline
 *  `{ harness, model? }`. Exactly one of `launchConfig` and `harness`; `model` only with `harness`. */
export function soulLaunchValue({ launchConfig, harness, model } = {}) {
  if (launchConfig !== undefined && harness !== undefined) throw fail("E_BAD_ARGS", "oats soul launch set takes --launch-config <name>|none or --harness <h>, not both", { flags: ["--launch-config", "--harness"] });
  if (launchConfig === undefined && harness === undefined) throw fail("E_BAD_ARGS", `oats soul launch set needs what to pin the soul to: --launch-config <name>|none, or --harness ${LAUNCH_HARNESSES.join("|")} [--model <id>]`, {});
  if (launchConfig !== undefined) {
    if (model !== undefined) throw fail("E_BAD_ARGS", "--model goes with --harness: a launch configuration carries its own model (oats launch-config set)", { flags: ["--launch-config", "--model"] });
    return launchConfig;
  }
  if (!LAUNCH_HARNESSES.includes(harness)) throw fail("E_BAD_ARGS", `--harness must be one of ${LAUNCH_HARNESSES.join(", ")} (got ${JSON.stringify(harness)})`, { harness });
  if (model !== undefined && !/^[^\s-][^\s]*$/.test(model)) throw fail("E_BAD_ARGS", `--model takes a model id: no whitespace, and no leading "-" (got ${JSON.stringify(model)})`, { model });
  return { harness, ...(model !== undefined ? { model } : {}) };
}

/** Set or delete `souls.launch.<key>` in the document, and nothing else. A map left empty is removed
 *  (`souls.launch`, then `souls`). An entry that stays keeps its own key node, so its quoting and comment. */
function applyEntry(doc, key, value) {
  if (value === null) {
    doc.deleteIn(["souls", "launch", key]);
    for (const path of [["souls", "launch"], ["souls"]]) {
      const node = doc.getIn(path);
      if (YAML.isMap(node) && node.items.length === 0) doc.deleteIn(path);
    }
    return;
  }
  // A key that holds no map (`souls:` with nothing under it) is replaced by the map the entry needs.
  for (const path of [["souls"], ["souls", "launch"]]) if (doc.hasIn(path) && !YAML.isMap(doc.getIn(path))) doc.deleteIn(path);
  doc.setIn(["souls", "launch", key], typeof value === "string" ? value : doc.createNode(value));
}
/** The local value this edit must read back as: `before` with the one entry set or deleted (value null). */
function expectedAfter(before, key, value) {
  const next = structuredClone(before);
  if (value === null) {
    delete next.souls.launch[key];
    if (Object.keys(next.souls.launch).length === 0) delete next.souls.launch;
    if (Object.keys(next.souls).length === 0) delete next.souls;
    return next;
  }
  if (!isObject(next.souls)) next.souls = {};
  if (!isObject(next.souls.launch)) next.souls.launch = {};
  next.souls.launch[key] = structuredClone(value);
  return next;
}
/** Where two values differ, as JSON pointers (never the values: this file holds host paths). A map whose
 *  keys are the same in another order differs at the map. */
function differences(a, b, path = "", out = []) {
  if (!isObject(a) || !isObject(b)) { if (!same(a, b)) out.push(path || "/"); return out; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (!same(ka, kb)) {
    const stray = [...ka.filter((k) => !Object.hasOwn(b, k)), ...kb.filter((k) => !Object.hasOwn(a, k))];
    if (stray.length) for (const k of stray) out.push(`${path}/${String(k).replace(/~/g, "~0").replace(/\//g, "~1")}`);
    else out.push(path || "/");
  }
  for (const k of ka) if (Object.hasOwn(b, k)) differences(a[k], b[k], `${path}/${String(k).replace(/~/g, "~0").replace(/\//g, "~1")}`, out);
  return out;
}

/**
 * `oats soul launch set|remove`. `ctx`: { deployment, localPath }. `name`: the command's argument (a soul
 * as a spawn names it, "*", or for `remove` the exact text of a key in the file). `value`: soulLaunchValue's
 * (set only). `plan`: every check, nothing written. `readSouls()` reads the workspace → its discovery
 * (discoverOrStandalone), and throws that read's own error.
 * → the `soulLaunchApi: 1` answer. Every refusal is thrown before a byte of the file changes.
 */
export async function soulLaunch(ctx, { action, name, value = null, plan = false }, { readSouls }) {
  const star = name === "*";
  // `remove` first tries its argument as the exact text of a key the file has now: that form needs no
  // read of the workspace, so it goes on (and says so: `unread`) when the souls cannot be read.
  const now = action === "remove" ? launchOf(readLocal(ctx.localPath).local) : {};
  const exact = action === "remove" && Object.hasOwn(now, name);
  if (action === "remove" && star && !exact) throw unknownEntry("*", now);
  let discovery = null, unread = null;
  try { discovery = await readSouls(); }
  catch (e) { if (!exact || !isRefusal(e)) throw e; unread = { code: e.code, message: String(e.message) }; }
  const entry = star || exact ? null : findSoulEntry(discovery, name);
  const key = entry ? soulKeyOf(entry) : name;

  let before = null;
  const result = editLocal(ctx, { verb: `oats soul launch ${action}`, plan }, ({ doc, local }) => {
    const entries = launchOf(local);
    before = Object.hasOwn(entries, key) ? launchValueOf(entries[key]) : null;
    if (action === "remove") { if (!Object.hasOwn(entries, key)) throw unknownEntry(key, entries); }
    else {
      // The same fact a spawn reports, said before the file holds it.
      const configs = isObject(local?.["launch-configs"]) ? local["launch-configs"] : {};
      if (typeof value === "string" && value !== "none" && !Object.hasOwn(configs, value)) {
        throw fail("E_LAUNCH_CONFIG_UNKNOWN", `--launch-config ${JSON.stringify(value)} is no launch configuration ${LOCAL_FILE} declares (launch-configs:); oats launch-config list shows what is; nothing was written`, { name: value, from: star ? "local-default" : "local", at: launchKeyAt(key) });
      }
      if (Object.hasOwn(entries, key) && same(before, launchValueOf(value))) return null;
    }
    const written = action === "remove" ? null : value;
    applyEntry(doc, key, written);
    const expected = expectedAfter(local, key, written);
    return { check: (next) => {
      const differ = differences(expected, next);
      if (differ.length) throw fail("E_WORKSPACE_SCHEMA", `the rewritten ${LOCAL_FILE} would not read back as this edit of souls.launch and nothing else (it differs at ${named(differ)}); nothing was written`, { path: ctx.localPath, reason: "read-back", differs: differ });
    } };
  });

  const local = result.local;
  const after = Object.hasOwn(launchOf(local), key) ? launchValueOf(launchOf(local)[key]) : null;
  const answer = { soulLaunchApi: SOUL_LAUNCH_API, action, plan, key, souls: null, level: ctx.deployment, file: ctx.localPath, before, after, changed: result.changed, launch: null, unmatched: null, unread };
  if (unread) return answer;
  // What the entry applies to: every offered soul with that key (two members' souls of one bare name share it).
  const applies = star ? [] : soulCandidates(discovery).map((c) => c.entry).filter((e) => soulKeyOf(e) === key)
    .sort((a, b) => (qualifiedSoulName(a) < qualifiedSoulName(b) ? -1 : qualifiedSoulName(a) > qualifiedSoulName(b) ? 1 : 0));
  if (!star) answer.souls = applies.map(qualifiedSoulName);
  // The soul the command named; a key given by its exact text names the first soul it applies to.
  const subject = entry ?? applies[0] ?? null;
  const offered = soulsOffered(discovery);
  if (subject) {
    let launchConfigs = {};
    try { launchConfigs = launchConfigsAt(ctx.deployment); } catch { launchConfigs = {}; }
    // As a spawn of it would decide: a soul left on the fall-through beside a key that names no soul
    // carries that refusal as the report's problem.
    answer.launch = launchReportFor({ layers: launchLayers({ definition: subject.definition, entry: subject, key, local, offered }), launchConfigs, contextDir: ctx.deployment });
  }
  answer.unmatched = launchKeysUnmatched({ local, offered }).unmatched;
  return answer;
}

/** E_LAUNCH_PREFERENCE_UNKNOWN: `remove` of an entry the file does not have. Never "done": a mistyped
 *  remove must not leave the entry its operator believes is gone. */
function unknownEntry(key, entries) {
  const keys = Object.keys(entries).sort();
  return fail("E_LAUNCH_PREFERENCE_UNKNOWN", `${LOCAL_FILE} souls.launch has no entry ${JSON.stringify(key)} (${keys.length ? `it has ${named(keys.map((k) => JSON.stringify(k)))}` : "it has none"}); nothing was written`, { key, keys });
}
