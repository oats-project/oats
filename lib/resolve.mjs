/**
 * lib/resolve.mjs — from a soul to an immutable resolution (module contract §3).
 *
 * Contract: docs/design/2026-09-23-workspace-module-contracts.md §3.
 * Decision: https://github.com/awebai/oats-knowledge/blob/main/knowledge/nodes/oats-maintainer/decisions/workspace-model-v2.md (6, 12, 14, 16, 19–21).
 *
 * `resolveSoul(discovery, soulEntry, options)` turns a discovered soul into the
 * exact set of modules an instance will be built from: which capability comes
 * from where (a confirmed member at its latest commit, or a locked package at
 * its pinned commit), which module fills each core-capability slot, the merged
 * provider payload per capability, the composed skill set, the injects, and a
 * `revision` that changes whenever any of that changes.
 *
 * Resolution is a handshake check plus a lookup — never a search:
 *   - `from: here`      → the soul's own repo.
 *   - `from: <repo>`    → a CONFIRMED member (E_NOT_A_MEMBER) that lists the capability under
 *                         capabilities/<name>/oats.json (E_CAPABILITY_MISSING); a private capability
 *                         is usable only from its own repo (E_CAPABILITY_PRIVATE). It NEVER looks
 *                         inside the repo's oats-package/ (non-collapse rule): a name that exists only
 *                         there fails with details.hint "provided by package <id>; use from: package".
 *   - `from: package`   → the lock's packageProviding(name) (E_PACKAGE_MISSING). There is no approval
 *                         gate: declaring the package in `packages:` is the trust decision (human
 *                         decision 2026-09-24). It NEVER looks at member capabilities, even when the
 *                         package's repo is a member.
 *
 * Composition order (soul wins; `off` removes):
 *   workspace.defaults.{knowledge,messaging,tasks} (slot defaults; a soul `none` drops them)
 *   ⊕ workspace.defaults.capabilities ⊕ soul.capabilities. (Team labels compose nothing: 0.30 removed
 *   defaults.byTeam, so a soul's composition is the same for every person and machine.)
 *
 * Slot `none` (contract §3, post-0.25.0 rule): a soul's `<slot>: none` EMPTIES the slot — it drops the
 * workspace's `defaults.<slot>` AND any capability of that layer the workspace defaults contributed
 * (`defaults.capabilities`). A layer-bearing capability the SOUL ITSELF declares
 * next to `none` is contradictory and stays E_SLOT_CONFLICT { reason: "none" } (spell `<cap>: off` to
 * remove a default explicitly; drop the soul's own line to fill the slot).
 *
 * Package modules are read at the locked commit, and the lock must describe that tree: the capability
 * list `<path>/oats-package.json` declares there must equal the entry's `capabilities`, else
 * E_PACKAGE_INTEGRITY { why: "capabilities", listed, locked }.
 *
 * Revision (decision 14 + preview): `declRevision` fingerprints the declarations (soul identity, modules
 * with their commits/versions/manifests, slots, skills, injects); `payloadRevision` fingerprints the merged
 * provider payloads; `revision` = hash(declRevision, payloadRevision) so a spawn decision still binds to
 * everything, while a preview can say WHAT changed since the previous instance (declarations | payload | both).
 *
 * Payloads (decision 14), later wins on scalars/arrays, objects deep-merge:
 *   manifest defaults ⊕ workspace.<slot> (messaging and tasks slots only: WORKSPACE_PAYLOAD_SLOTS)
 *   ⊕ soul.<slot> ⊕ local.settings[cap] ⊕ spawn.providers[cap]
 * A manifest settings key marked hostOnly comes only from local.settings[cap]; one marked committedOnly
 * never comes from local.settings[cap] or spawn.providers[cap] (#1719).
 *
 * This module shells out to nothing. Remote access is injected (`remote`, default
 * lib/remote.mjs; `remoteOptions` threaded into every call). `resolveSoul` is
 * `async` because member skill trees and package capability manifests are read
 * over the remote; everything else is pure and exported for direct testing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { oatsError as baseOatsError } from "./errors.mjs";
import * as defaultRemote from "./remote.mjs";
import { BY_TEAM_REMOVED, reportRows, soulTeams, teamKeyOf, teamModel } from "./teams.mjs";
import { bindRemote, packageProviding, readPackageManifests, validateLock } from "./packages.mjs";
import { APPROVED_HOOKS, settingValueProblems } from "./capability-contract.mjs";
import { memberRowByKey } from "./workspace.mjs";
import { currentRepoKey, sameRepo } from "./repo-moves.mjs";

export const RESOLUTION_API = 1;
export const SLOTS = Object.freeze(["knowledge", "messaging", "tasks"]);
/** The slots whose payload oats-workspace.yaml may carry at its root (`messaging:`, `tasks:` since #1719). */
const WORKSPACE_PAYLOAD_SLOTS = Object.freeze(["messaging", "tasks"]);
const CONTRACT_DOC = "docs/design/2026-09-23-workspace-module-contracts.md";

/* ───────────────────────────── helpers ────────────────────────────────── */

/** oatsError with `details` readable as both e.provenance (today) and e.details (the contract). */
function fail(code, message, details) {
  const e = baseOatsError(code, message, details);
  if (details !== undefined) e.details = details;
  return e;
}
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => JSON.stringify(v);
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const short = (oid) => String(oid || "").slice(0, 12);

/** Keys a payload may never carry: `__proto__` as an own key (yaml/JSON produce it) would set the
 * prototype of the merged object — a value invisible to JSON/canonicalJson (so the recorded payload
 * and the revision look clean) yet visible to every in-process property read. Refused, never skipped. */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertPayloadKeys(value, path) {
  if (Array.isArray(value)) { value.forEach((v, i) => assertPayloadKeys(v, `${path}/${i}`)); return; }
  if (!isObject(value)) return;
  for (const k of Object.keys(value)) {
    if (POISON_KEYS.has(k)) throw fail("E_WORKSPACE_SCHEMA", `provider payload key ${show(k)} at ${path || "/"} is refused (it would poison the merged payload's prototype)`, { path: `${path}/${k}`, key: k, reason: "poison-key" });
    assertPayloadKeys(value[k], `${path}/${k}`);
  }
}

/** Deep-merge provider payloads: plain objects merge recursively; arrays and scalars — later wins.
 * Payload keys `__proto__` / `constructor` / `prototype` (at any depth) → E_WORKSPACE_SCHEMA. */
export function mergePayload(...layers) {
  let out = {};
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (!isObject(layer)) throw new TypeError(`a provider payload must be an object, got ${typeof layer}`);
    assertPayloadKeys(layer, "");
    out = mergeInto(out, layer);
  }
  return out;
}
function mergeInto(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (POISON_KEYS.has(k)) throw fail("E_WORKSPACE_SCHEMA", `provider payload key ${show(k)} is refused`, { key: k, reason: "poison-key" });
    out[k] = isObject(v) && isObject(out[k]) ? mergeInto(out[k], v) : clone(v);
  }
  return out;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** A manifest's declared setting defaults (`settings.<key>.default`) as a payload layer: the
 *  intrinsic field fallbacks, merged BELOW every workspace, soul, host and spawn layer. */
export function manifestDefaultsPayload(manifest) {
  const out = {};
  if (!isObject(manifest?.settings)) return out;
  for (const [key, declaration] of Object.entries(manifest.settings)) {
    if (isObject(declaration) && Object.hasOwn(declaration, "default") && declaration.default !== undefined) out[key] = clone(declaration.default);
  }
  return out;
}

/** Where each leaf of a merged payload came from: JSON pointer → the origin of the LAST layer that
 *  set it, under mergePayload's rules (objects merge recursively; arrays and scalars replace, taking
 *  every leaf below them with them). `layers` is [{ payload, origin }] in merge order. */
export function payloadOrigins(layers) {
  const origins = {};
  const escape = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
  const dropBelow = (pointer) => { for (const p of Object.keys(origins)) if (p === pointer || p.startsWith(`${pointer}/`)) delete origins[p]; };
  const walk = (value, pointer, origin, mergedBefore) => {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const at = `${pointer}/${escape(k)}`;
      if (isObject(v) && isObject(mergedBefore?.[k])) { delete origins[at]; walk(v, at, origin, mergedBefore[k]); }
      else if (isObject(v) && Object.keys(v).length) { dropBelow(at); walk(v, at, origin, null); }
      else { dropBelow(at); origins[at] = origin; }
    }
  };
  let merged = {};
  for (const { payload, origin } of layers) {
    if (!isObject(payload)) continue;
    walk(payload, "", origin, merged);
    merged = mergeInto(merged, payload);
  }
  return origins;
}

/** `byTeam` was removed in 0.30 (team model v2): in any payload layer — the workspace's messaging, a soul's
 * slot payload, local.settings[cap], spawn.providers[cap] — it would reach the provider verbatim as a dead
 * key; refused at the layer's top level with E_WORKSPACE_SCHEMA reason "removed-key" and the path named. */
const REMOVED_KEY = "byTeam";
function assertNoReservedKey(value, path) {
  if (isObject(value) && Object.hasOwn(value, REMOVED_KEY)) {
    throw fail("E_WORKSPACE_SCHEMA", `${path}/${REMOVED_KEY}: ${BY_TEAM_REMOVED}`, { path: `${path}/${REMOVED_KEY}`, key: REMOVED_KEY, reason: "removed-key" });
  }
}

/** Settings keys a manifest marks `hostOnly: true` (decision 27, K1″). */
export function hostOnlyKeys(manifest) {
  const out = new Set();
  const decl = isObject(manifest?.settings) ? manifest.settings : {};
  for (const [key, spec] of Object.entries(decl)) if (isObject(spec) && spec.hostOnly === true) out.add(key);
  return out;
}
/** Refuse a hostOnly key in a committed or per-spawn payload layer: only oats-local.yaml `settings.<cap>` may carry it. */
function assertNoHostOnlyKey(value, path, hostOnly, capability) {
  if (!hostOnly.size || !isObject(value)) return;
  for (const key of hostOnly) {
    if (Object.hasOwn(value, key)) {
      throw fail("E_WORKSPACE_SCHEMA", `${path}/${key}: ${show(key)} is a host-only setting of ${capability} (its manifest marks it hostOnly) — it may appear only in the deployment's oats-local.yaml under settings.${capability}, never in a committed workspace or soul file or a --provider flag (decision 27)`, { path: `${path}/${key}`, key, capability, reason: "host-only-key" });
    }
  }
}

/** Settings keys a manifest marks `committedOnly: true` (#1719): the mirror of hostOnly. */
export function committedOnlyKeys(manifest) {
  const out = new Set();
  const decl = isObject(manifest?.settings) ? manifest.settings : {};
  for (const [key, spec] of Object.entries(decl)) if (isObject(spec) && spec.committedOnly === true) out.add(key);
  return out;
}
/** The checks the resolver makes of oats-local.yaml's `settings.<capability>` payload before it merges it: no
 *  removed key, and no key the manifest marks committedOnly. One function for the resolver (resolveSoul) and
 *  for the command that writes that payload (`oats settings set`, lib/settings-set.mjs), so that a value the
 *  command accepts is one a spawn accepts. `layer` is the capability's own (its manifest's). */
export function assertHostSettings(payload, { capability, layer, manifest }) {
  const path = `/settings/${capability}`;
  assertNoReservedKey(payload, path);
  assertNoCommittedOnlyKey(payload, { path, layer: "host", at: `oats-local.yaml#/settings/${capability}`, committedOnly: committedOnlyKeys(manifest), capability, capabilityLayer: layer });
}
/** Refuse a value outside the manifest's `settings.<key>.values` in `payload`, where it was set (`atOf(key)`,
 *  or null): a conditional `requires` row reads it, so a typo would silently skip every such row. The
 *  resolver's check of a merged payload, and `oats settings set`'s of the one it writes. */
export function assertSettingValues(manifest, payload, { capability, atOf = () => null }) {
  for (const { key, value, values } of settingValueProblems(manifest, payload)) {
    const at = atOf(key);
    throw fail("E_WORKSPACE_SCHEMA", `${capability}: setting ${show(key)} is ${show(value)}, not one of ${values.map(show).join(", ")}${at ? ` (set at ${at})` : ""}`, { capability, key, value, values, at, reason: "setting-value" });
  }
}
/** Where a committedOnly key of a capability with this layer may be set: the committed payload layers the
 *  resolver merges for it (`at` strings, as payloadOrigins names them), and the words for the refusal. */
function committedOnlyHomes(layer, key) {
  if (WORKSPACE_PAYLOAD_SLOTS.includes(layer)) {
    return { allowed: [`oats-workspace.yaml#/${layer}`, `soul.yaml#/${layer}`], where: `oats-workspace.yaml under ${layer}: or a soul's ${layer}: payload`, fix: `Set it in oats-workspace.yaml under ${layer}:, or remove it` };
  }
  if (layer) return { allowed: [`soul.yaml#/${layer}`], where: `a soul's ${layer}: payload`, fix: `Set it in the soul's ${layer}: payload, or remove it` };
  return { allowed: [`oats.json#/settings/${key.replace(/~/g, "~0").replace(/\//g, "~1")}/default`], where: "its manifest default (the capability has no layer, so no committed payload reaches it)", fix: "Remove it" };
}
/** Refuse a committedOnly key in the host or spawn layer: only committed, reviewed files may set it (#1719). */
function assertNoCommittedOnlyKey(value, { path, layer, at, committedOnly, capability, capabilityLayer }) {
  if (!committedOnly.size || !isObject(value)) return;
  for (const key of committedOnly) {
    if (!Object.hasOwn(value, key)) continue;
    const homes = committedOnlyHomes(capabilityLayer, key);
    const setIn = layer === "host" ? `oats-local.yaml settings.${capability}` : `--provider ${capability}`;
    throw fail("E_WORKSPACE_SCHEMA", `${path}/${key}: ${show(key)} is a committed-only setting of ${capability} (its manifest marks it committedOnly): it was set in ${setIn}, and may be set only in a committed file — ${homes.where}. ${homes.fix} from ${setIn}`,
      { path: `${path}/${key}`, key, capability, reason: "committed-only-key", layer, at, allowed: homes.allowed });
  }
}

/** Canonical JSON: object keys sorted (recursively), arrays in order, no whitespace. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(byCodepoint).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** revision = sha256(canonical JSON)[0:24] — the fingerprint a spawn decision embeds. */
export function revisionOf(body) {
  return createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 24);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A repo ref lib/remote.mjs can open for a canonical key ("<host>/<path>" | "local/<abs>"). */
export function refForKey(key) {
  if (typeof key !== "string" || !key) throw fail("E_REPO_REF", `not a repo key: ${show(key)}`, { key });
  return key.startsWith("local/") ? key.slice("local/".length) : `git:${key}`;
}

function remoteOf({ remote, remoteOptions } = {}) {
  const r = remote ?? defaultRemote;
  for (const name of ["parseRepoRef", "readRemoteFile", "listRemoteTree"]) {
    if (typeof r?.[name] !== "function") throw new TypeError(`remote must provide ${name}() (module contract §1)`);
  }
  return bindRemote(r, remoteOptions);
}

/* ───────────────────────────── semver-ish ranges ──────────────────────── */

const VERSION_RE = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v2.1.3-rc.1+build" → { major, minor, patch, prerelease: ["rc", 1] } | null. */
export function parseVersion(text) {
  const m = typeof text === "string" && VERSION_RE.exec(text.trim());
  if (!m) return null;
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? 0 : Number(s));
  return {
    major: Number(m[1]), minor: num(m[2]), patch: num(m[3]),
    prerelease: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}
/** Two parsed versions (parseVersion) in semver order: negative, zero or positive. */
export function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;   // a release outranks any prerelease of the same triple
  if (b.prerelease.length === 0) return -1;
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;    // numeric identifiers rank below alphanumeric ones
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?(.+)$/;
/** One comparator → [{ op, version }] (a partial or ^/~ form expands to a lower and upper bound). */
function expandComparator(token) {
  if (token === "*" || token === "" || /^[xX]$/.test(token)) return [];
  const m = COMPARATOR_RE.exec(token);
  if (!m) return null;
  const op = m[1] || "";
  const raw = m[2];
  const parts = VERSION_RE.exec(raw.replace(/^v/, ""));
  if (!parts) return null;
  const v = parseVersion(raw);
  const hasMinor = parts[2] !== undefined && !/^[xX*]$/.test(parts[2]);
  const hasPatch = parts[3] !== undefined && !/^[xX*]$/.test(parts[3]);
  const bump = (major, minor, patch) => ({ major, minor, patch, prerelease: [] });
  const lower = { op: ">=", version: v };
  if (op === "^") {
    const upper = v.major > 0 || !hasMinor ? bump(v.major + 1, 0, 0) : v.minor > 0 || !hasPatch ? bump(0, v.minor + 1, 0) : bump(0, 0, v.patch + 1);
    return [lower, { op: "<", version: upper }];
  }
  if (op === "~") return [lower, { op: "<", version: hasMinor ? bump(v.major, v.minor + 1, 0) : bump(v.major + 1, 0, 0) }];
  if (op === "" || op === "=") {
    if (hasMinor && hasPatch) return [{ op: "=", version: v }];
    return [lower, { op: "<", version: hasMinor ? bump(v.major, v.minor + 1, 0) : bump(v.major + 1, 0, 0) }];
  }
  if (!hasMinor || !hasPatch) {
    // >=1.2 → >=1.2.0 ; <1.2 → <1.2.0 ; >1.2 → >=1.3.0 ; <=1.2 → <1.3.0
    const next = hasMinor ? bump(v.major, v.minor + 1, 0) : bump(v.major + 1, 0, 0);
    if (op === ">") return [{ op: ">=", version: next }];
    if (op === "<=") return [{ op: "<", version: next }];
  }
  return [{ op, version: v }];
}
const OPS = {
  ">=": (c) => c >= 0, ">": (c) => c > 0, "<=": (c) => c <= 0, "<": (c) => c < 0, "=": (c) => c === 0,
};

/**
 * Does `version` satisfy `range`? Supports `>=`, `>`, `<=`, `<`, `=`, `^`, `~`, exact, partial
 * (`1.2`), `*`, whitespace-AND and `||`-OR. No dependency. Throws E_COMPATIBILITY { why: "range" }
 * for an unparseable range and { why: "version" } for an unparseable version.
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) throw fail("E_COMPATIBILITY", `cannot compare ${show(version)}: not a version`, { why: "version", version, range });
  if (typeof range !== "string") throw fail("E_COMPATIBILITY", `not a version range: ${show(range)}`, { why: "range", range });
  const alternatives = range.split("||").map((alt) => alt.trim());
  for (const alt of alternatives) {
    const tokens = alt.length ? alt.split(/\s+/) : [""];
    const comparators = [];
    for (const token of tokens) {
      const expanded = expandComparator(token);
      if (expanded === null) throw fail("E_COMPATIBILITY", `not a version range: ${show(range)} (at ${show(token)})`, { why: "range", range, token });
      comparators.push(...expanded);
    }
    if (comparators.every((c) => OPS[c.op](compareVersions(v, c.version)))) return true;
  }
  return false;
}

/** The running kernel's version: a capability's `compatibility.oats` range is checked against it. */
export const KERNEL_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** A capability manifest's own kernel range (`compatibility.oats`) against `kernel`:
 *  `{ ok, range, kernel }`; `range: null` (always ok) when the manifest declares none. Throws
 *  E_CAPABILITY_INCOMPATIBLE { why: "range" } for a range that is not a version range. */
export function kernelCompatibility(manifest, kernel = KERNEL_VERSION) {
  const range = isObject(manifest?.compatibility) && Object.hasOwn(manifest.compatibility, "oats") ? manifest.compatibility.oats : null;
  if (range === null) return { ok: true, range: null, kernel };
  try { return { ok: satisfiesRange(kernel, range), range, kernel }; }
  catch (e) {
    if (e?.code !== "E_COMPATIBILITY") throw e;
    throw fail("E_CAPABILITY_INCOMPATIBLE", `${manifest?.capability ?? "capability"}: compatibility.oats ${show(range)} is not a version range`, { capability: manifest?.capability ?? null, range, kernel, why: "range" });
  }
}

/* ───────────────────────────── composition ────────────────────────────── */

const choiceOf = (value, path, via) => {
  if (value === "off") return "off";
  if (isObject(value) && typeof value.from === "string" && value.from) {
    // `here` has a referent only in a soul (its own repo); a workspace default would mean a different repo per soul.
    if (value.from === "here" && via !== "soul") throw fail("E_WORKSPACE_SCHEMA", `${path}/from: "here" is only meaningful in a soul; a workspace default names a repo key or package`, { path: `${path}/from`, value: value.from });
    return { from: value.from };
  }
  throw fail("E_WORKSPACE_SCHEMA", `${path} must be { from: <location> } or "off", got ${show(value)}`, { path, value });
};

/**
 * The ordered capability map of a soul BEFORE any lookup:
 *   slot defaults (dropped where the soul says `none`) ⊕ defaults.capabilities ⊕ soul.capabilities
 * → [{ name, from, via }] sorted by name; `off` removes the entry from every lower layer.
 * `via` is one of "defaults.<slot>" | "defaults.capabilities" | "soul".
 * `offs` (optional, feature desktop-facts): receives what the soul turned off — { name, reason: "off",
 * overrides } for each capability its own `off` removed from a lower layer, and { name, reason: "slot-none",
 * slot, overrides: "workspace" } for a slot default its `<slot>: none` dropped (`overrides`: fromOfVia vocabulary).
 */
export function composeCapabilities(workspace, soulDefinition, { offs = null } = {}) {
  const map = new Map();
  const apply = (entries, via, path) => {
    for (const [name, value] of Object.entries(entries || {})) {
      const choice = choiceOf(value, `${path}/${name}`, via);
      if (choice === "off" && via === "soul" && offs && map.has(name)) offs.push({ name, reason: "off", overrides: fromOfVia(map.get(name).via) });
      if (choice === "off") map.delete(name);
      else map.set(name, { name, from: choice.from, via });
    }
  };
  const defaults = isObject(workspace?.defaults) ? workspace.defaults : {};
  for (const slot of SLOTS) {
    const d = defaults[slot];
    if (soulDefinition?.[slot] === "none" && offs && isObject(d)) for (const name of Object.keys(d)) offs.push({ name, reason: "slot-none", slot, overrides: "workspace" });
    if (soulDefinition?.[slot] === "none" || d === "none" || !isObject(d)) continue;
    const names = Object.keys(d);
    if (names.length > 1) throw fail("E_WORKSPACE_SCHEMA", `defaults.${slot} names ${names.length} capabilities; a slot default names at most one`, { path: `/defaults/${slot}`, names });
    apply(d, `defaults.${slot}`, `/defaults/${slot}`);
  }
  apply(defaults.capabilities, "defaults.capabilities", "/defaults/capabilities");
  apply(soulDefinition?.capabilities, "soul", "/capabilities");
  return [...map.values()].sort((a, b) => byCodepoint(a.name, b.name));
}

/**
 * The order a soul's capability instructions take in its composed AGENTS.md: the capabilities the soul
 * lists, in its `capabilities:` order, then the workspace defaults it does not list, in the order the
 * workspace's `defaults:` lists them (slot defaults and `defaults.capabilities` entries as they appear in
 * the file). Each capability sits where the entry that composed it (its `via`) lists it, so a soul entry
 * that re-lists a default sits at the soul's position. A name made only of digits comes first in its map
 * (JavaScript orders integer-like keys first): a documented quirk. `declared` is composeCapabilities' output,
 * over the same workspace and soul definition. → [name], every declared name once.
 */
export function instructionOrder(workspace, soulDefinition, declared) {
  const viaOf = new Map(declared.map((d) => [d.name, d.via]));
  const order = [];
  const take = (entries, via) => {
    for (const name of Object.keys(isObject(entries) ? entries : {})) if (viaOf.get(name) === via && !order.includes(name)) order.push(name);
  };
  take(soulDefinition?.capabilities, "soul");
  const defaults = isObject(workspace?.defaults) ? workspace.defaults : {};
  for (const key of Object.keys(defaults)) {
    if (key === "capabilities") take(defaults.capabilities, "defaults.capabilities");
    else if (SLOTS.includes(key)) take(defaults[key], `defaults.${key}`);
  }
  return order;
}

/* ───────────────────────────── lookups ────────────────────────────────── */

/** A discovery's member row by key (the first with that key; lib/workspace.mjs memberRowByKey). */
const memberRow = (discovery, repoKey) => memberRowByKey(discovery?.members, repoKey);

/** The ref the workspace lists a member under (keeps the operator's spelling: ssh vs https); else from the key.
 *  The key → first listed ref index is built once per members array and parseRepoRef. A moved repository's
 *  two spellings find one ref (lib/repo-moves.mjs), and the ref goes to Git as the workspace wrote it. */
const memberRefIndex = new WeakMap();
export function memberRef(discovery, remote, repoKey) {
  const members = discovery?.workspace?.members;
  if (Array.isArray(members)) {
    let byParser = memberRefIndex.get(members);
    if (!byParser) memberRefIndex.set(members, byParser = new Map());
    let index = byParser.get(remote.parseRepoRef);
    if (!index) {
      index = new Map();
      for (const ref of members) {
        try { const key = currentRepoKey(remote.parseRepoRef(ref).key); if (!index.has(key)) index.set(key, ref); } catch { /* validated upstream */ }
      }
      byParser.set(remote.parseRepoRef, index);
    }
    if (index.has(currentRepoKey(repoKey))) return index.get(currentRepoKey(repoKey));
  }
  return refForKey(repoKey);
}

/** Resolve `from: <repo>` (or `here`) against member capabilities only — the non-collapse rule. */
function lookupMember(discovery, soul, name, from, via, lock) {
  const repoKey = from === "here" ? soul.repoKey : from;
  const row = memberRow(discovery, repoKey);
  const where = { capability: name, from, repoKey, soul: soul.name, via };
  const standaloneOwn = discovery?.standalone === true && sameRepo(repoKey, soul.repoKey) && row !== null;
  if (!row) {
    const ws = discovery?.key ? ` ${discovery.key}` : "";
    throw fail("E_NOT_A_MEMBER", `${name}: ${from === "here" ? `here (${repoKey})` : repoKey} is not a member of the workspace${ws} — a capability comes from a confirmed member or from a package`, { ...where, reason: "not-listed" });
  }
  if (!row.confirmed && !standaloneOwn) {
    throw fail("E_NOT_A_MEMBER", `${name}: ${repoKey} is listed but not confirmed (${row.reason || "unconfirmed"}${row.detail ? `: ${row.detail}` : ""})`, { ...where, reason: row.reason || "unconfirmed", detail: row.detail });
  }
  const cap = (row.capabilities || []).find((c) => c.name === name) || null;
  if (!cap) {
    const details = { ...where, commit: row.commit };
    // Discovery found the manifest but refused it (lib/capability-contract.mjs): say that, not "missing".
    const refused = (discovery?.problems || []).filter((p) => sameRepo(p.repoKey, repoKey) && typeof p.path === "string" && p.path.startsWith(`capabilities/${name}/oats.json#`));
    if (refused.length) throw fail("E_WORKSPACE_SCHEMA", `${name}: ${repoKey}@${short(row.commit)} declares it, but its manifest is refused: ${refused.map((p) => `${p.path}: ${p.message}`).join("; ")}`, { ...details, problems: refused, reason: "manifest-contract" });
    // The name may live in a package tier: say so, but never resolve it from here (decision 19).
    const providing = safePackageProviding(lock, name);
    let hint = null;
    if (providing) hint = `provided by package ${providing.id}; use from: package`;
    else if (row.publishes?.package) hint = `${repoKey} publishes package ${row.publishes.package}; a capability under oats-package/ is package-tier — pin the package in packages: and use from: package`;
    throw fail("E_CAPABILITY_MISSING", `${name}: ${repoKey}@${short(row.commit)} has no capabilities/${name}/oats.json${hint ? ` (${hint})` : ""}`, hint ? { ...details, hint } : details);
  }
  if (cap.private && !sameRepo(cap.repoKey, soul.repoKey)) {
    throw fail("E_CAPABILITY_PRIVATE", `${name}: ${repoKey} marks it private; it is usable only by souls of ${repoKey} (this soul lives in ${soul.repoKey})`, { ...where, owner: repoKey, soulRepo: soul.repoKey });
  }
  return { row, cap };
}
function safePackageProviding(lock, name) {
  if (!isObject(lock)) return null;
  try { return packageProviding(lock, name); } catch { return null; }
}

/** Resolve `from: package` through the lock only — never through member capabilities.
 *  Declaring a package in the workspace's packages: is the trust decision (human
 *  decision 2026-09-24), so a workspace view admits only a locked package the
 *  workspace STILL declares: a package removed from packages: but left in a stale
 *  lock (no `oats sync` since) is refused, never materialized. `declared` is null
 *  for a standalone view — its lock holds only what a standalone sync wrote. */
function lookupPackage(lock, name, via, soul, declared) {
  const where = { capability: name, from: "package", soul: soul.name, via };
  if (!isObject(lock) || !isObject(lock.packages)) throw fail("E_PACKAGE_MISSING", `${name}: from: package needs the workspace lock (oats-lock.json v3) — run \`oats sync\``, { ...where, reason: "no-lock" });
  const providing = packageProviding(lock, name);
  if (!providing) throw fail("E_PACKAGE_MISSING", `${name}: no locked package provides it — add the package to packages: and run \`oats sync\``, { ...where, locked: Object.keys(lock.packages).sort() });
  if (declared && !Object.hasOwn(declared, providing.id)) throw fail("E_PACKAGE_MISSING", `${name}: the lock's package ${providing.id} is no longer declared in the workspace's packages: — run \`oats sync\` (or declare it again)`, { ...where, id: providing.id, reason: "undeclared" });
  return providing;
}

/** `from: here` in a package soul: the capability must be one its OWN locked package provides. */
function ownPackageEntry(lock, name, via, soul, id) {
  const where = { capability: name, from: "here", soul: soul.name, via, package: id };
  const entry = isObject(lock?.packages) ? lock.packages[id] : null;
  if (!isObject(entry)) throw fail("E_PACKAGE_MISSING", `${name}: from: here in package soul ${id}/${soul.name} needs ${id} in the lock — run \`oats sync\``, { ...where, reason: "no-lock" });
  if (!entry.capabilities.includes(name)) throw fail("E_CAPABILITY_MISSING", `${name}: from: here in package soul ${id}/${soul.name}, but package ${id} v${entry.version} provides [${entry.capabilities.join(", ")}]`, { ...where, version: entry.version, listed: [...entry.capabilities] });
  return { id, entry };
}

/** The repo ref a locked package is read from: the lock's recorded url, else the catalog's url for catalog ids, else the key for git refs. */
export function packageRef(id, entry, catalog, remote) {
  const cat = isObject(catalog) ? (isObject(catalog.packages) && !("url" in catalog.packages) ? catalog.packages : catalog) : {};
  if (entry.source === `catalog:${id}`) {
    if (typeof entry.url === "string" && entry.url) return entry.url;
    const c = cat[id];
    if (isObject(c) && typeof c.url === "string") return c.url;
    throw fail("E_PACKAGE_MISSING", `${id}: locked from the catalog, but neither the lock (url) nor a catalog entry says which repo to read it from — run \`oats sync\` (lock v3 records url) or pass { catalog } to resolveSoul`, { id, source: entry.source, reason: "no-catalog" });
  }
  const m = /^git:(.+)@([^@]+)$/.exec(entry.source);
  if (!m) throw fail("E_LOCK_SCHEMA", `${id}: lock source ${show(entry.source)} is neither catalog:<id> nor git:<key>@<ref>`, { id, source: entry.source });
  const key = m[1];
  const ref = refForKey(key);
  remote.parseRepoRef(ref); // E_REPO_REF for a smuggled key
  return ref;
}

/* ───────────────────────────── skills ─────────────────────────────────── */

const SAFE_REL = (rel) => typeof rel === "string" && rel && !posix.isAbsolute(rel) && !/^[\\/]/.test(rel) && !/\0/.test(rel) && !rel.split(/[\\/]/).some((p) => p === "..");

/** Normalize a manifest-declared relative path ("./skills/x/" → "skills/x"); null when unsafe. */
export function declaredPath(rel) {
  if (!SAFE_REL(rel)) return null;
  const n = posix.normalize(rel).replace(/\/+$/, "");
  return n === "." || n === "" || n.startsWith("../") ? null : n;
}

/** A relative path no listing of a checkout can hold: absolute, empty, a `.`/`..`/`.git` (any case) or empty
 *  component, a trailing slash, a backslash or a NUL. */
export function unsafeRelPath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.endsWith("/") || /[\\\0]/.test(path)) return true;
  return path.split("/").some((c) => c === "" || c === "." || c === ".." || c.toLowerCase() === ".git");
}

/** A manifest-declared path as the module install reads it (lib/materialize.mjs modulePath: a backslash is a
 *  separator, `./` and trailing slashes dropped), and only when the result is a safe POSIX path (unsafeRelPath);
 *  else null. What `oats capabilities show` reports for an inject or a skill. */
export function manifestFilePath(rel) {
  const declared = declaredPath(rel);
  if (!declared) return null;
  const n = posix.normalize(declared.replace(/\\/g, "/")).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return unsafeRelPath(n) ? null : n;
}

/**
 * Skills declared by a manifest: each `skills[]` entry is a directory under the capability that either
 * IS a skill (holds SKILL.md) or holds skill directories (<entry>/<skill>/SKILL.md) — the same reading
 * the 0.24 kernel applied. `listing` is a listRemoteTree()-shaped array RELATIVE TO THE ENTRY.
 * → [{ name, path }] with path relative to the capability directory.
 */
export function skillsInListing(declared, listing) {
  const out = [];
  const blobs = new Set((listing || []).filter((e) => e.type === "blob").map((e) => e.path));
  if (blobs.has("SKILL.md")) return [{ name: posix.basename(declared), path: declared }];
  for (const p of [...blobs].sort(byCodepoint)) {
    const m = /^([^/]+)\/SKILL\.md$/.exec(p);
    if (m) out.push({ name: m[1], path: posix.join(declared, m[1]) });
  }
  return out;
}

/** Enumerate the skills of one module over the remote (or a discovery-provided listing). */
async function enumerateSkills({ remote, ref, commit, dir, manifest, listing, moduleName, missing }) {
  const declaredList = Array.isArray(manifest.skills) ? manifest.skills : [];
  const skills = [];
  for (const raw of declaredList) {
    const declared = declaredPath(raw);
    if (!declared) throw missing(raw, "unsafe", `declares skills entry ${show(raw)}, which is not a relative path inside the capability`);
    let entries;
    if (Array.isArray(listing)) {
      // Discovery already listed the capability directory (relative to it): project onto this entry.
      entries = listing.filter((e) => e.path === declared || e.path.startsWith(`${declared}/`)).map((e) => ({ ...e, path: e.path === declared ? "" : e.path.slice(declared.length + 1) })).filter((e) => e.path);
    } else {
      // A listing at a commit never changes: the parsed cache keeps it (lib/remote.mjs memoAtCommit).
      const at = posix.join(dir, declared);
      const list = () => remote.listRemoteTree(ref, commit, at, { depth: 2 });
      entries = typeof remote.memoAtCommit === "function" ? await remote.memoAtCommit(ref, commit, `list\0${at}\0${2}`, list) : await list();
    }
    const found = skillsInListing(declared, entries);
    if (found.length === 0) throw missing(raw, "skill-missing", `declares skills entry ${show(raw)} but no SKILL.md is there (neither ${declared}/SKILL.md nor ${declared}/*/SKILL.md)`);
    for (const s of found) skills.push({ module: moduleName, name: s.name, path: s.path });
  }
  return skills;
}

/** What a capability provides, by name (feature desktop-facts): its skills (enumerated exactly as a spawn
 *  would), commands and hooks (the events this kernel runs: an unknown one never runs here). `skills` is
 *  null when its declared skills cannot be listed (a spawn of it would refuse; the listing does not). */
export async function capabilityProvides({ ref, commit, dir, manifest, remote: injected, remoteOptions }) {
  const keys = (o) => (isObject(o) ? Object.keys(o).sort(byCodepoint) : []);
  const { skills } = await capabilitySkills({ ref, commit, dir, manifest, remote: injected, remoteOptions });
  return { skills: skills && skills.map((s) => s.name), commands: keys(manifest.commands), hooks: keys(manifest.hooks).filter((event) => APPROVED_HOOKS.has(event)) };
}

/** A capability's skills as a spawn enumerates them (enumerateSkills), sorted by name in codepoint order:
 *  → { skills: [{ name, path }] (path relative to the capability directory), problem: null }, or
 *  { skills: null, problem } when the declared skills cannot be enumerated — `problem` the oats error a spawn
 *  would meet (`missingCode`: E_CAPABILITY_MISSING for a member, E_PACKAGE_MANIFEST for a package), or a skill
 *  path that is not safe (manifestFilePath). Paths are as the install reads them. The one reading of
 *  `manifest.skills` behind `oats capabilities` (capabilityProvides) and `oats capabilities show`. */
export async function capabilitySkills({ ref, commit, dir, manifest, remote: injected, remoteOptions, missingCode = "E_CAPABILITY_MISSING" }) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  const missing = (raw, why, text) => fail(missingCode, `${manifest.capability} ${text}`, { capability: manifest.capability, skill: raw, why });
  try {
    const skills = [];
    for (const { name, path } of await enumerateSkills({ remote, ref, commit, dir, manifest, moduleName: manifest.capability, missing })) {
      // A skill path is reported as the install reads it, and only when it is a safe POSIX path (a `.git`
      // directory the remote serves is one a spawn's fetch refuses).
      const safe = manifestFilePath(path);
      if (!safe) throw missing(path, "unsafe", `declares skill ${show(name)} at ${show(path)}, which is not a safe path inside the capability`);
      skills.push({ name, path: safe });
    }
    return { skills: skills.sort((a, b) => byCodepoint(a.name, b.name)), problem: null };
  } catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return { skills: null, problem: e }; throw e; }
}

/** The capability manifests of a locked package, read at its locked commit (feature desktop-facts). */
export async function lockedPackageCapabilities(id, entry, { catalog = null, remote: injected, remoteOptions } = {}) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  const ref = packageRef(id, entry, catalog, remote);
  const { capabilities } = await readPackageManifests(remote, ref, entry.commit, entry.path, { id, version: entry.version, commit: entry.commit });
  return { ref, capabilities };
}

/** The lock must describe the tree it names: the capability list a package's manifests declare at the locked
 *  commit (`capabilities`, readPackageManifests) must equal the lock entry's, and must hold `name`, else
 *  E_PACKAGE_INTEGRITY. → that capability { name, dir, manifest }. Spawn's check (resolveSoul), shared with
 *  `oats capabilities show`. */
export function lockedCapability(name, id, entry, capabilities, details = { capability: name, id, version: entry.version, commit: entry.commit, path: entry.path }) {
  const listed = capabilities.map((c) => c.name).sort(), locked = [...entry.capabilities].sort(); // validateLock guarantees the array
  if (listed.length !== locked.length || listed.some((c, i) => c !== locked[i])) {
    throw fail("E_PACKAGE_INTEGRITY", `${name}: the lock says package ${id} v${entry.version} provides [${locked.join(", ")}], but ${entry.path}/oats-package.json at ${short(entry.commit)} declares [${listed.join(", ")}]`, { ...details, why: "capabilities", listed, locked });
  }
  const cap = capabilities.find((c) => c.name === name);
  if (!cap) throw fail("E_PACKAGE_INTEGRITY", `${name}: the lock says package ${id} v${entry.version} provides it, but ${entry.path}/oats-package.json at ${short(entry.commit)} does not`, { ...details, listed: capabilities.map((c) => c.name) });
  return cap;
}

/* ───────────────────────────── resolveSoul ────────────────────────────── */

/**
 * From a discovered soul to an immutable Resolution.
 *
 * discovery: discoverWorkspace(...) output (or standaloneRepo(...) output — from:here only).
 * soulEntry: one of discovery.members[].souls[] or discovery.external[].soul
 *            ({ name, path, repoKey, commit, team, private, definition }).
 * options:   { local, lock, spawn = { providers? }, catalog, remote, remoteOptions }
 *            `catalog` (package-catalog.json shape) tells which repo a `catalog:<id>` lock entry is read from.
 *
 * → Resolution { resolutionApi: 1, soul, modules[], slots, payloads, payloadOrigins, skills[], injects[], instructionOrder[], revision } — deep-frozen.
 * Extra fields beyond the contract (recorded for materialize): module.dir (capability dir, repo-relative)
 * and from.repoKey on package modules.
 */
export async function resolveSoul(discovery, soulEntry, { local = null, lock = null, spawn = {}, catalog = null, remote: injected, remoteOptions, kernel = KERNEL_VERSION } = {}) {
  if (!isObject(soulEntry) || typeof soulEntry.name !== "string" || typeof soulEntry.repoKey !== "string") {
    throw new TypeError("resolveSoul: soulEntry must be a discovery SoulEntry { name, path, repoKey, commit, team, private, definition }");
  }
  if (!isObject(spawn)) throw new TypeError("resolveSoul: spawn must be an object");
  if (lock !== null && lock !== undefined) validateLock(lock); // E_LOCK_SCHEMA: a lock passed in memory meets the same bar as one read from disk
  const remote = remoteOf({ remote: injected, remoteOptions });
  const workspace = isObject(discovery?.workspace) ? discovery.workspace : null;
  assertSoulDiscovered(discovery, soulEntry);
  const definition = isObject(soulEntry.definition) ? soulEntry.definition : {};
  const soul = { name: soulEntry.name, repoKey: soulEntry.repoKey, commit: soulEntry.commit ?? null, path: soulEntry.path ?? null };
  // Team model 3: the soul's teams HERE (the workspace's teams, defaultTeam and souls:, and the local teams
  // it allows). An undeclared local default (E_TEAM_UNKNOWN) or local teams the workspace does not allow
  // (E_WORKSPACE_SCHEMA local-teams-closed) refuse the soul.
  const soulTeamsHere = soulTeams(teamModel(discovery?.standalone === true ? null : workspace, local, { workspaceKey: discovery?.key ?? null }), teamKeyOf(soulEntry));

  // Standalone: the soul's own repo only, workspace defaults unknown (decision 10).
  // What the soul turned off (feature desktop-facts): its own `off` over a lower layer, and a `<slot>: none`
  // that dropped a workspace default below. Provenance, like slotsFrom.
  const offs = [];
  const composedWorkspace = discovery?.standalone === true ? null : workspace;
  const composedSoul = discovery?.standalone === true ? { ...definition, capabilities: soulEntry.capabilities ?? definition.capabilities } : definition;
  const declared = composeCapabilities(composedWorkspace, composedSoul, { offs });
  const turnedOff = offs;

  const modules = [];
  const skills = [];
  const injects = [];
  // Slot `none` (L1 rule): a layer-bearing capability the WORKSPACE DEFAULTS contributed for a slot the soul
  // empties is dropped here, before any lookup — the soul asked for no <slot> and never named it. A layer
  // is known only from the manifest, so a member capability is peeked at in discovery and a package one at
  // its lock entry's manifest; a soul-declared one is never dropped (it is a conflict, judged below).
  const emptied = new Set(SLOTS.filter((slot) => definition[slot] === "none"));
  for (const { name, from, via } of declared) {
    let module;
    const ownPackage = from === "here" && typeof soulEntry.package === "string";
    if (from === "package" || ownPackage) {
      // `from: here` in a package soul is its own package, at the locked commit (§2.2).
      const { id, entry } = ownPackage
        ? ownPackageEntry(lock, name, via, soul, soulEntry.package)
        : lookupPackage(lock, name, via, soul, discovery?.standalone === true ? null : (isObject(workspace?.packages) ? workspace.packages : {}));
      const ref = packageRef(id, entry, catalog, remote);
      const details = { capability: name, id, version: entry.version, commit: entry.commit, path: entry.path };
      const { capabilities } = await readPackageManifests(remote, ref, entry.commit, entry.path, details);
      const cap = lockedCapability(name, id, entry, capabilities, details);
      const layer = layerOf(cap.manifest);
      if (layer && emptied.has(layer) && via !== "soul") { turnedOff.push({ name, reason: "slot-none", slot: layer, overrides: fromOfVia(via) }); continue; }
      module = {
        name, from: { kind: "package", package: id, version: entry.version, commit: entry.commit, integrity: entry.integrity, repoKey: remote.parseRepoRef(ref).key },
        manifest: clone(cap.manifest), layer, private: cap.manifest.private === true, dir: cap.dir,
      };
      const missing = (raw, why, text) => fail("E_PACKAGE_MANIFEST", `${name} (package ${id} v${entry.version}) ${text}`, { ...details, skill: raw, why });
      skills.push(...await enumerateSkills({ remote, ref, commit: entry.commit, dir: cap.dir, manifest: cap.manifest, moduleName: name, missing }));
    } else {
      const { row, cap } = lookupMember(discovery, soul, name, from, via, lock);
      const layer = layerOf(cap.manifest);
      if (layer && emptied.has(layer) && via !== "soul") { turnedOff.push({ name, reason: "slot-none", slot: layer, overrides: fromOfVia(via) }); continue; }
      const ref = memberRef(discovery, remote, cap.repoKey);
      module = {
        name, from: { kind: "member", repoKey: cap.repoKey, commit: cap.commit ?? row.commit },
        manifest: clone(cap.manifest), layer, private: cap.private === true, dir: cap.path,
      };
      const missing = (raw, why, text) => fail("E_CAPABILITY_MISSING", `${name} (${cap.repoKey}@${short(module.from.commit)}) ${text}`, { capability: name, repoKey: cap.repoKey, commit: module.from.commit, skill: raw, why });
      skills.push(...await enumerateSkills({ remote, ref, commit: module.from.commit, dir: cap.path, manifest: cap.manifest, listing: cap.listing, moduleName: name, missing }));
    }
    if (typeof module.manifest.inject === "string" && module.manifest.inject) {
      const inject = declaredPath(module.manifest.inject);
      if (!inject) throw fail(module.from.kind === "package" ? "E_PACKAGE_MANIFEST" : "E_CAPABILITY_MISSING", `${name} declares inject ${show(module.manifest.inject)}, which is not a relative path inside the capability`, { capability: name, inject: module.manifest.inject, why: "unsafe" });
      injects.push({ module: name, path: inject });
    }
    modules.push(module);
  }

  // Slots: a resolved capability whose manifest has layer X fills slot X; two → conflict. A soul `none` has
  // already emptied the slot of every workspace-default contribution (above); what remains under `none` is
  // the soul's own contradiction → E_SLOT_CONFLICT { reason: "none" } — judged FIRST, so it is never reported
  // as a two-module clash.
  const slots = { knowledge: null, messaging: null, tasks: null };
  const slotsFrom = { knowledge: null, messaging: null, tasks: null };
  const viaOf = new Map(declared.map((d) => [d.name, d.via]));
  for (const m of modules) {
    const via = viaOf.get(m.name);
    const slotDefault = typeof via === "string" && via.startsWith("defaults.") && SLOTS.includes(via.slice("defaults.".length)) ? via.slice("defaults.".length) : null;
    // A slot default must fill THAT slot: its manifest's layer is the slot (contract §3 "else workspace default").
    if (slotDefault && m.layer !== slotDefault) {
      throw fail("E_SLOT_CONFLICT", `slot ${slotDefault}: defaults.${slotDefault} names ${m.name}, whose manifest declares layer ${m.layer ? show(m.layer) : "none"} — a slot default must be a ${slotDefault}-layer capability`, { slot: slotDefault, modules: [m.name], soul: soul.name, reason: "layer-mismatch", layer: m.layer });
    }
    if (!m.layer) continue;
    if (emptied.has(m.layer)) throw fail("E_SLOT_CONFLICT", `slot ${m.layer}: the soul says ${m.layer}: none but itself names ${m.name}, which declares layer ${m.layer} — drop one of the two (a workspace default of that layer would have been dropped by none; this one is the soul's own)`, { slot: m.layer, modules: [m.name], soul: soul.name, reason: "none", via });
    if (slots[m.layer]) throw fail("E_SLOT_CONFLICT", `slot ${m.layer}: both ${slots[m.layer]} and ${m.name} declare layer ${m.layer}; a soul fills each slot with at most one capability`, { slot: m.layer, modules: [slots[m.layer], m.name], soul: soul.name });
    slots[m.layer] = m.name;
    slotsFrom[m.layer] = fromOfVia(via);
  }

  // Duplicate skill names within the composed set (decision 16).
  const seenSkills = new Map();
  for (const s of skills) {
    if (seenSkills.has(s.name)) {
      const prior = seenSkills.get(s.name);
      throw fail("E_SKILL_DUPLICATE", `skill ${show(s.name)} is contributed by both ${prior.module} (${prior.path}) and ${s.module} (${s.path})`, { name: s.name, modules: [prior.module, s.module], paths: [prior.path, s.path], soul: soul.name });
    }
    seenSkills.set(s.name, s);
  }

  // Payloads (decision 14; addendum 5): manifest defaults ⊕ workspace.<slot> (messaging and tasks slots) ⊕ soul.<slot>
  // ⊕ local.settings[cap] ⊕ spawn.providers[cap], each leaf's origin kept in payloadOrigins.
  const settings = isObject(local?.settings) ? local.settings : {};
  const providers = isObject(spawn.providers) ? spawn.providers : {};
  const moduleNames = new Set(modules.map((m) => m.name));
  // Own keys only (Object.entries): a provider name that is merely inherited by `providers` is not a request.
  for (const [cap, value] of Object.entries(providers)) {
    if (!isObject(value)) throw new TypeError(`spawn.providers.${cap} must be an object`);
    if (POISON_KEYS.has(cap)) throw fail("E_WORKSPACE_SCHEMA", `spawn.providers.${cap}: capability name ${show(cap)} is refused (it would poison the payload's prototype)`, { path: `/spawn/providers/${cap}`, key: cap, reason: "poison-key" });
    assertNoReservedKey(value, `/spawn/providers/${cap}`);
    if (!moduleNames.has(cap)) throw fail("E_CAPABILITY_MISSING", `--provider ${cap}: the soul ${soul.name} does not resolve a capability named ${show(cap)} (modules: ${[...moduleNames].sort().join(", ") || "none"})`, { capability: cap, soul: soul.name, hint: "a provider payload targets one of the soul's resolved capabilities", modules: [...moduleNames].sort() });
  }
  const payloads = {}, origins = {};
  // The soul's slot payloads are checked whether or not the slot resolves to a module: a reserved key is a
  // schema fault of the soul, not of the spawn that happened to fill the slot.
  for (const slot of SLOTS) if (isObject(definition[slot])) assertNoReservedKey(definition[slot], `/${slot}`);
  for (const m of modules) {
    // Addendum 5: the manifest's declared defaults are the LOWEST layer, so the preview shows (and the
    // provider receives) e.g. identity.mode = local with its origin, not an absent key.
    const layers = [], sourced = [];
    const add = (payload, origin) => { layers.push(payload); sourced.push({ payload, origin }); };
    for (const [key, value] of Object.entries(manifestDefaultsPayload(m.manifest))) {
      add({ [key]: value }, { kind: "manifest-default", at: `oats.json#/settings/${key.replace(/~/g, "~0").replace(/\//g, "~1")}/default` });
    }
    // Decision 27 (K1″): a manifest may mark a settings key `hostOnly` — a host fact (a custody
    // path, a state directory) that only the deployment's own oats-local.yaml may supply. Every
    // committed or per-spawn layer is refused with that key present, BEFORE the merge, because the
    // provider receives one merged payload without provenance and cannot enforce this itself.
    const hostOnly = hostOnlyKeys(m.manifest);
    const committed = (payload, path, origin) => { assertNoHostOnlyKey(payload, path, hostOnly, m.name); add(payload, origin); };
    // #1719: the mirror — a key marked `committedOnly` must be the same for every deployment (a shared
    // task list), so the host layer and --provider are refused with it present, BEFORE the merge, for the
    // same reason. Marked both, no layer but the manifest default could set it: a fault of the manifest.
    const committedOnly = committedOnlyKeys(m.manifest);
    for (const key of committedOnly) {
      if (hostOnly.has(key)) throw fail(m.from.kind === "package" ? "E_PACKAGE_MANIFEST" : "E_CAPABILITY_MISSING", `${m.name} marks setting ${show(key)} both hostOnly and committedOnly, so no layer but its manifest default could set it — drop one of the two flags`, { capability: m.name, key, why: "settings-flag-conflict" });
    }
    const notCommitted = (payload, path, layer, at) => assertNoCommittedOnlyKey(payload, { path, layer, at, committedOnly, capability: m.name, capabilityLayer: m.layer });
    // The provider's settings are base ⊕ workspace ⊕ soul ⊕ host ⊕ spawn. Teams are not settings: they reach the
    // provider beside them (OATS_DEFAULT_TEAM*, OATS_TEAMS).
    if (WORKSPACE_PAYLOAD_SLOTS.includes(m.layer) && isObject(workspace?.[m.layer])) {
      assertNoReservedKey(workspace[m.layer], `/${m.layer}`);
      committed(workspace[m.layer], `/${m.layer}`, { kind: "workspace", at: `oats-workspace.yaml#/${m.layer}` });
    }
    if (m.layer && isObject(definition[m.layer])) { assertNoReservedKey(definition[m.layer], `/${m.layer}`); committed(definition[m.layer], `/${m.layer}`, { kind: "soul", at: `soul.yaml#/${m.layer}` }); }
    if (Object.hasOwn(settings, m.name) && isObject(settings[m.name])) { assertHostSettings(settings[m.name], { capability: m.name, layer: m.layer, manifest: m.manifest }); add(settings[m.name], { kind: "host", at: `oats-local.yaml#/settings/${m.name}` }); } // the host layer: hostOnly keys are legal here, committedOnly ones are not
    if (Object.hasOwn(providers, m.name) && isObject(providers[m.name])) {
      notCommitted(providers[m.name], `/spawn/providers/${m.name}`, "spawn", `--provider ${m.name}`);
      committed(providers[m.name], `/spawn/providers/${m.name}`, { kind: "spawn", at: `--provider ${m.name}` });
    }
    payloads[m.name] = mergePayload(...layers);
    origins[m.name] = payloadOrigins(sourced);
    // A value outside the manifest's `settings.<key>.values` is refused where it was set (assertSettingValues).
    assertSettingValues(m.manifest, payloads[m.name], { capability: m.name, atOf: (key) => origins[m.name][`/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`]?.at ?? null });
  }

  // Each capability's own kernel range (its manifest's compatibility.oats) must admit the running
  // kernel: a package or member capability written for another kernel is refused before anything
  // is composed from it, never discovered at its first hook.
  for (const m of modules) {
    const c = kernelCompatibility({ ...m.manifest, capability: m.name }, kernel);
    if (c.ok) continue;
    const remedy = m.from.kind === "package"
      ? `pin a release of ${m.from.package} whose range admits ${kernel} in the workspace's packages:, or run a kernel the range admits`
      : `update ${m.name} in ${m.from.repoKey}, or run a kernel the range admits`;
    throw fail("E_CAPABILITY_INCOMPATIBLE", `${m.name} requires oats ${c.range}; this kernel is ${kernel} — ${remedy}`, { capability: m.name, range: c.range, kernel, from: m.from });
  }

  // Capability-defined agents (`agents:` in a manifest) were removed in 0.29.0: an agent ships as a
  // soul. A module still declaring them is refused before anything is composed from it.
  for (const m of modules) {
    if (m.manifest?.agents === undefined) continue;
    const agents = Array.isArray(m.manifest.agents) ? m.manifest.agents.filter((a) => typeof a === "string") : [];
    const how = "ship each agent as a soul — a package soul (`souls/<name>/` beside the package's capabilities, spawned as `oats spawn <package>/<name>`) or a member soul (`souls/<name>/` in a member) — and drop `agents:` from the manifest";
    const remedy = m.from.kind === "package" ? `pin a release of ${m.from.package} without \`agents:\`, or ${how}` : `in ${m.from.repoKey}: ${how}`;
    throw fail("E_CAPABILITY_AGENTS_REMOVED", `${m.name} declares \`agents:\` (${agents.join(", ") || "…"}); capability-defined agents were removed in OATS 0.29.0 — ${remedy}`, { capability: m.name, agents, from: m.from });
  }

  // Compatibility floors (soul.compatibility) are constraints on PACKAGE versions.
  for (const [cap, range] of Object.entries(isObject(definition.compatibility) ? definition.compatibility : {})) {
    const m = modules.find((x) => x.name === cap);
    if (!m || m.from.kind !== "package") continue;
    const where = { capability: cap, package: m.from.package, version: m.from.version, range, soul: soul.name };
    // A git:<repo>@<OID> package carries the OID as its version: unversioned, so no floor can be met (even an all-digit OID).
    if (/^[0-9a-f]{40}$/i.test(String(m.from.version)) || !parseVersion(m.from.version)) {
      throw fail("E_COMPATIBILITY", `${cap}: package ${m.from.package} is pinned at ${show(m.from.version)}, which is not a version — the soul's floor ${show(range)} cannot be checked; pin a tagged version in packages.${m.from.package}`, { ...where, why: "unversioned" });
    }
    let ok;
    try { ok = satisfiesRange(m.from.version, range); }
    catch (e) { if (e?.code === "E_COMPATIBILITY") throw fail("E_COMPATIBILITY", `${cap}: ${e.message}`, { ...where, ...(e.details || {}) }); throw e; }
    if (!ok) {
      throw fail("E_COMPATIBILITY", `${cap}: package ${m.from.package} is pinned at v${m.from.version}, below the soul's floor ${show(range)} — bump packages.${m.from.package} in the workspace`, where);
    }
  }

  modules.sort((a, b) => byCodepoint(a.name, b.name));
  skills.sort((a, b) => byCodepoint(a.module, b.module) || byCodepoint(a.name, b.name));
  injects.sort((a, b) => byCodepoint(a.module, b.module));
  // L6: two fingerprints — declarations (what is composed, at which commits/versions) and payload (the merged
  // provider settings) — so a preview can say what changed; `revision` binds both, exactly as before.
  const decl = { resolutionApi: RESOLUTION_API, soul, modules, slots, skills, injects };
  const declRevision = revisionOf(decl);
  const payloadRevision = revisionOf(payloads);
  const revision = revisionOf({ declRevision, payloadRevision });
  // payloadOrigins is provenance only: it is derived from the same inputs the two revisions already
  // bind, so it does not enter either fingerprint. `teams` / `defaultTeam` (team model v2) are
  // deployment-local messaging state, not composition: they stay out of both fingerprints too.
  // `slotsFrom` (where each filled slot's capability came from) is provenance, like payloadOrigins: outside
  // both fingerprints, so the same capability reached another way is not a composition change. So are
  // `capabilitiesFrom` (the same per composed capability) and `turnedOff` (feature desktop-facts).
  const teams = reportRows(soulTeamsHere.teams), defaultTeam = soulTeamsHere.defaultTeam;
  const capabilitiesFrom = Object.fromEntries(modules.map((m) => [m.name, fromOfVia(viaOf.get(m.name))]));
  // `instructionOrder` (the order the modules' injects take in the composed AGENTS.md: the soul's listing,
  // then the workspace defaults' file order) is provenance too: reordering a soul's list is no composition change.
  const order = instructionOrder(composedWorkspace, composedSoul, declared).filter((name) => moduleNames.has(name));
  turnedOff.sort((a, b) => byCodepoint(a.name, b.name));
  return deepFreeze({ ...decl, payloads, payloadOrigins: origins, teams, defaultTeam, slotsFrom, capabilitiesFrom, instructionOrder: order, turnedOff, declRevision, payloadRevision, revision });
}

/** Where a composed capability came from, as the Desktop names it (`layers.<layer>.from`): the soul's own
 *  entry → "soul"; defaults.<slot> or defaults.capabilities → "workspace". */
export function fromOfVia(via) {
  if (via === "soul") return "soul";
  if (typeof via === "string" && via.startsWith("defaults.")) return "workspace";
  return null;
}

function layerOf(manifest) {
  return SLOTS.includes(manifest?.layer) ? manifest.layer : null;
}

/**
 * Membership gate (decision 1, contract §3): the soul must be one discovery actually listed — a soul of a
 * CONFIRMED member row (same repoKey, name and commit), an `external[]` soul, or (standalone) the repo's own.
 * A soul of an unconfirmed member → E_MEMBERSHIP_UNCONFIRMED { repoKey, reason }; a soul of a repo the
 * workspace does not list → E_NOT_A_MEMBER; a row that does not carry this soul → E_MEMBERSHIP_UNCONFIRMED { reason: "stale" }.
 */
function assertSoulDiscovered(discovery, soulEntry) {
  const { name, repoKey } = soulEntry;
  const where = { soul: name, repoKey };
  const sameSoul = (s) => isObject(s) && s.name === name && sameRepo(s.repoKey, repoKey) && (s.commit ?? null) === (soulEntry.commit ?? null);
  if (typeof soulEntry.package === "string") {
    // A package soul: the discovery listed it from the lock, at this package's locked commit.
    if ((discovery?.packageSouls || []).some((s) => sameSoul(s) && s.package === soulEntry.package)) return;
    throw fail("E_PACKAGE_MISSING", `soul ${soulEntry.package}/${name}: the discovery does not list it at ${short(soulEntry.commit)} — the soul entry is stale; run \`oats sync\` and discover again`, { ...where, package: soulEntry.package, reason: "stale" });
  }
  if ((discovery?.external || []).some((e) => sameSoul(e?.soul))) return;
  const row = memberRow(discovery, repoKey);
  if (!row) throw fail("E_NOT_A_MEMBER", `soul ${name}: ${repoKey} is not a member of the workspace${discovery?.key ? ` ${discovery.key}` : ""} (nor an external soul) — a soul is spawned from a confirmed member or an external entry`, { ...where, reason: "not-listed" });
  if (!row.confirmed && !(discovery?.standalone === true)) {
    throw fail("E_MEMBERSHIP_UNCONFIRMED", `soul ${name}: ${repoKey} is listed but its membership is not confirmed (${row.reason || "unconfirmed"}${row.detail ? `: ${row.detail}` : ""}) — an unconfirmed member contributes nothing but its row`, { ...where, reason: row.reason || "unconfirmed", detail: row.detail ?? null });
  }
  if (!(row.souls || []).some(sameSoul)) {
    throw fail("E_MEMBERSHIP_UNCONFIRMED", `soul ${name}: ${repoKey}@${short(row.commit)} does not list it at that commit — the soul entry is stale or fabricated; re-run discovery`, { ...where, reason: "stale", commit: row.commit, soulCommit: soulEntry.commit ?? null });
  }
}

export { CONTRACT_DOC as RESOLVE_CONTRACT };
