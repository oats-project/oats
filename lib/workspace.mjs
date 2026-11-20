/**
 * lib/workspace.mjs — declarations, membership, discovery (module contract §2).
 *
 * Reads the four v2 declaration files (oats-workspace.yaml, oats-membership.yaml,
 * soul.yaml, oats-local.yaml) over Git remotes through lib/remote.mjs, validates
 * them against docs/*.schema.json with a small in-module validator (no ajv at
 * runtime), observes the reciprocal membership handshake in the operator's own
 * access context, and enumerates every member's souls and capabilities.
 *
 * Nothing here shells out. Every remote access goes through the `remote`
 * option (defaults to lib/remote.mjs) so tests can inject an in-memory remote.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recordLocalInput } from "./local-inputs.mjs";
import { resolvedDeployment } from "./resolved-deployment.mjs";
import { parseConfigData } from "./config-data.mjs";
import { oatsError } from "./errors.mjs";
import * as defaultRemote from "./remote.mjs";
import { bindRemote, classifyPackageValue, lockedPackageRef } from "./packages.mjs";
import { manifestContractProblems, locatedContractWarnings } from "./capability-contract.mjs";
import YAML from "yaml";
import { BY_TEAM_REMOVED, TEAM_MEMBERSHIP_MOVED, soulsReplacement } from "./teams.mjs";
import { currentRepoKey, sameRepo } from "./repo-moves.mjs";
import { KERNEL_FEATURES } from "./kernel-features.mjs";
import { SANDBOXES_FEATURE, SANDBOX_EGRESS_FORGE_FEATURE, crossSandboxProblems, localSandboxProblems, workspaceSandboxProblems } from "./sandbox-model.mjs";

/* ───────────────────────────── errors ─────────────────────────────────── */

/** oatsError with `details` readable as both e.provenance (today) and e.details. */
function fail(code, message, details) {
  const e = oatsError(code, message, details);
  if (details !== undefined) e.details = details;
  return e;
}

/* ───────────────────────────── remote access ──────────────────────────── */

// lib/remote.mjs is the default remote (contract §1); callers may inject `{ remote }` (tests use an
// in-memory fake) and thread `{ remoteOptions }` (cacheDir, exec, …) into every remote call.
function remoteOf(options) {
  const remote = assertRemoteApi(options?.remote ?? defaultRemote);
  return bindRemote(remote, options?.remoteOptions);
}
/** The parsed cache (lib/remote.mjs memoAtCommit, optional on the remote contract): `compute()` is a pure
 *  function of the bytes at (ref's key, commit) and this kernel. A remote without it — every in-memory fake —
 *  just computes. */
/** Whether a member's enumeration may be missing a soul: it says so (`soulsSkipped`, enumerateRepo), or it
 *  carries no such record. What a read did not record, it did not establish: an enumeration that was not
 *  written by this build (whatever built it) says nothing about the souls it skipped, so it counts as one
 *  that skipped some. The parsed cache is not how that arises: its entries are kept per kernel fingerprint,
 *  and another build's are never read (lib/remote.mjs, test/parsed-cache.test.mjs). */
const skippedSome = (soulsSkipped) => !Array.isArray(soulsSkipped) || soulsSkipped.length > 0;
function atCommit(remote, ref, commit, item, compute) {
  return typeof remote.memoAtCommit === "function" ? remote.memoAtCommit(ref, commit, item, compute) : compute();
}
const REQUIRED_REMOTE_API = ["parseRepoRef", "observeRemote", "readRemoteFile", "listRemoteTree"];
function assertRemoteApi(remote) {
  for (const name of REQUIRED_REMOTE_API) {
    if (typeof remote?.[name] !== "function") throw new TypeError(`remote must provide ${name}() (module contract §1)`);
  }
  return remote;
}

/* ───────────────────────────── schemas ────────────────────────────────── */

const SCHEMA_FILES = {
  workspace: "oats-workspace.schema.json",
  membership: "oats-membership.schema.json",
  soul: "soul.schema.json",
  local: "oats-local.schema.json",
};
const schemaCache = new Map();
function schemaFor(kind) {
  if (!schemaCache.has(kind)) {
    const file = SCHEMA_FILES[kind];
    if (!file) throw new TypeError(`unknown schema kind ${kind}`);
    schemaCache.set(kind, JSON.parse(readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8")));
  }
  return schemaCache.get(kind);
}

const pointerKey = (key) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const show = (v) => (v === undefined ? "undefined" : JSON.stringify(v));
const regexCache = new Map();
function regexOf(pattern) {
  if (!regexCache.has(pattern)) regexCache.set(pattern, new RegExp(pattern, "u"));
  return regexCache.get(pattern);
}
function deref(root, ref) {
  if (!ref.startsWith("#/")) throw new TypeError(`only local $ref is supported: ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) throw new TypeError(`unresolvable $ref ${ref}`);
  }
  return node;
}
function typeMatches(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}
function describe(schema) {
  if (schema.const !== undefined) return show(schema.const);
  if (schema.enum) return schema.enum.map(show).join(" | ");
  if (schema.$ref) return schema.$ref.replace(/^#\/\$defs\//, "");
  if (schema.type) return Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  return "value";
}

/** Small draft-07 subset validator: returns [{ path, message }] (empty = valid). */
export function validateAgainst(schema, value, { root = schema, path = "" } = {}) {
  const problems = [];
  const push = (p, message) => problems.push({ path: p, message });
  const check = (s, v, p) => {
    if (s.$ref) s = { ...deref(root, s.$ref), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref" && k !== "description")) };
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(v, t))) { push(p, `expected ${types.join(" | ")}, got ${typeOf(v)}`); return; }
    }
    if (s.const !== undefined && JSON.stringify(v) !== JSON.stringify(s.const)) { push(p, `expected ${show(s.const)}, got ${show(v)}`); return; }
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) { push(p, `expected one of ${s.enum.map(show).join(", ")}, got ${show(v)}`); return; }
    if (s.anyOf || s.oneOf) {
      const branches = s.anyOf || s.oneOf;
      const results = branches.map((b) => validateAgainst(b, v, { root, path: p }));
      const passing = results.filter((r) => r.length === 0).length;
      if (passing === 0) {
        // Prefer the branch whose shape matches the value's type; else summarize.
        const resolved = branches.map((b) => (b.$ref ? deref(root, b.$ref) : b));
        const byType = resolved.findIndex((b) => b.type && typeMatches(v, b.type));
        if (byType >= 0 && results[byType].length) problems.push(...results[byType]);
        else push(p, `expected ${resolved.map(describe).join(" | ")}, got ${show(v)}`);
        return;
      }
      if (s.oneOf && passing > 1) { push(p, `matches ${passing} alternatives, expected exactly one`); return; }
    }
    if (typeof v === "string") {
      if (s.minLength !== undefined && v.length < s.minLength) push(p, `must be at least ${s.minLength} character(s)`);
      if (s.maxLength !== undefined && v.length > s.maxLength) push(p, `${show(v.length > 80 ? `${v.slice(0, 80)}…` : v)} is ${v.length} characters: must be at most ${s.maxLength}`);
      if (s.pattern && !regexOf(s.pattern).test(v)) push(p, `${show(v)} does not match ${s.pattern}`);
    } else if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) push(p, `must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) push(p, `must be <= ${s.maximum}`);
    } else if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) push(p, `must have at least ${s.minItems} item(s)`);
      if (s.maxItems !== undefined && v.length > s.maxItems) push(p, `must have at most ${s.maxItems} item(s)`);
      if (s.uniqueItems) {
        const seen = new Map();
        v.forEach((item, i) => { const k = JSON.stringify(item); if (seen.has(k)) push(`${p}/${i}`, `duplicates item ${seen.get(k)}`); else seen.set(k, i); });
      }
      if (s.items) v.forEach((item, i) => check(s.items, item, `${p}/${i}`));
    } else if (isObject(v)) {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) push(p, `must have at least ${s.minProperties} propert${s.minProperties === 1 ? "y" : "ies"}`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) push(p, `must have at most ${s.maxProperties} propert${s.maxProperties === 1 ? "y" : "ies"} (got ${keys.join(", ")})`);
      for (const req of s.required || []) if (!Object.hasOwn(v, req)) push(p, `missing required property ${show(req)}`);
      for (const key of keys) {
        const kp = `${p}/${pointerKey(key)}`;
        if (s.propertyNames) {
          for (const pr of validateAgainst(s.propertyNames, key, { root, path: kp })) push(kp, `invalid key ${show(key)}: ${pr.message}`);
        }
        let matched = false;
        if (s.properties && Object.hasOwn(s.properties, key)) { matched = true; check(s.properties[key], v[key], kp); }
        if (s.patternProperties) for (const [pat, sub] of Object.entries(s.patternProperties)) if (regexOf(pat).test(key)) { matched = true; check(sub, v[key], kp); }
        if (!matched) {
          if (s.additionalProperties === false) push(kp, `unknown property ${show(key)}`);
          else if (isObject(s.additionalProperties)) check(s.additionalProperties, v[key], kp);
        }
      }
    }
  };
  check(schema, value, path);
  return problems;
}

/* ───────────────────────────── domain rules ───────────────────────────── */

const ABSOLUTE_PATH = /^(?:\/|\\\\|[A-Za-z]:[\\/])/;
/** The workspace file's REF/PATH fields — the only values the absolute-path refusal applies to (contract §2,
 * Phase B: "absolute paths" means bare filesystem paths as VALUES that stand for a repo or a path inside one;
 * host state belongs in oats-local.yaml). Free text (`teams.*.description`) and the opaque provider payload
 * (`messaging`) are never scanned: a description may mention `/srv`, a provider may
 * legitimately carry a socket path or a URL, and neither is a place the kernel resolves.
 * → [[path, value]] for members[], packages.*, stores.*, external[].source|soul, defaults.<slot|capabilities>.*.from
 */
function* refFields(value) {
  if (Array.isArray(value.members)) for (let i = 0; i < value.members.length; i++) if (typeof value.members[i] === "string") yield [`/members/${i}`, value.members[i]];
  if (isObject(value.packages)) for (const [id, v] of Object.entries(value.packages)) if (typeof v === "string") yield [`/packages/${pointerKey(id)}`, v];
  if (isObject(value.stores)) for (const [name, v] of Object.entries(value.stores)) if (typeof v === "string") yield [`/stores/${pointerKey(name)}`, v];
  if (Array.isArray(value.external)) for (let i = 0; i < value.external.length; i++) {
    const entry = value.external[i];
    if (!isObject(entry)) continue;
    for (const f of ["source", "soul"]) if (typeof entry[f] === "string") yield [`/external/${i}/${f}`, entry[f]];
  }
  if (isObject(value.defaults)) {
    const d = value.defaults;
    const froms = function* (caps, path) { if (isObject(caps)) for (const [name, choice] of Object.entries(caps)) if (isObject(choice) && typeof choice.from === "string") yield [`${path}/${pointerKey(name)}/from`, choice.from]; };
    for (const slot of ["knowledge", "messaging", "tasks", "capabilities"]) yield* froms(d[slot], `/defaults/${slot}`);
  }
}
/** Only schema diagnostics for repository-reference fields pass the remote renderer. Provider
 * payloads and unrelated invalid values keep their original diagnostics; admission uses raw values. */
function referenceProblems(problems, refs) {
  const sources = new Map(refs);
  return problems.map((problem) => sources.has(problem.path)
    ? { ...problem, message: defaultRemote.displayDiagnosticText(problem.message, sources.get(problem.path)) }
    : problem);
}

function refKey(remote, ref) {
  return remote.parseRepoRef(ref).key;
}
/** Push a problem for a ref that parseRepoRef refuses; returns the key or null. */
function keyOrProblem(remote, ref, path, problems) {
  try { return refKey(remote, ref); }
  catch (e) {
    if (e?.code === "E_REPO_REF") { problems.push({ path, message: `not a repo ref: ${e.message}` }); return null; }
    throw e;
  }
}

/** Schema + domain problems for an oats-workspace.yaml value. Refs are parsed with `remote`
 * (default lib/remote.mjs) so duplicate members and malformed refs are always caught. */
export function validateWorkspace(value, { remote = defaultRemote, features = KERNEL_FEATURES } = {}) {
  const problems = validateAgainst(workspaceSchemaFor(features), value).map(newerRootKeyHint);
  if (!isObject(value)) return problems;
  if (value.schemaVersion !== 2) return referenceProblems(problems, refFields(value));
  // Absolute-path refusal applies to REF/PATH fields only (L2): never to descriptions or the provider payload.
  for (const [path, s] of refFields(value)) {
    if (ABSOLUTE_PATH.test(s)) problems.push({ path, message: `absolute paths are refused in the workspace file (${show(s)}); host paths belong in oats-local.yaml (a local remote is a repo ref: file:///… or git:/abs/bare.git@<ref>)` });
  }
  // packages: exactly two value forms (contract §2 non-collapse rule) — a catalog version or git:<repo>@<ref>.
  if (isObject(value.packages)) for (const [id, v] of Object.entries(value.packages)) {
    const c = classifyPackageValue(v);
    if (c.problem) { problems.push({ path: `/packages/${pointerKey(id)}`, message: `${c.problem} (a package is a bare version like v2.1.3 or git:<repo>@<ref>)` }); continue; }
    if (c.kind === "git") keyOrProblem(remote, c.repo, `/packages/${pointerKey(id)}`, problems);
  }
  if (Array.isArray(value.members)) {
    const seen = new Map();
    value.members.forEach((ref, i) => {
      if (typeof ref !== "string") return;
      const key = keyOrProblem(remote, ref, `/members/${i}`, problems);
      if (key === null) return;
      if (seen.has(key)) problems.push({ path: `/members/${i}`, message: `duplicates member ${seen.get(key)} (${key})` });
      else seen.set(key, i);
    });
  }
  if (isObject(value.stores)) for (const [name, ref] of Object.entries(value.stores)) if (typeof ref === "string") keyOrProblem(remote, ref, `/stores/${pointerKey(name)}`, problems);
  if (isObject(value.messaging) && Object.hasOwn(value.messaging, "byTeam")) {
    problems.push({ path: "/messaging/byTeam", reason: "removed-key", message: "messaging.byTeam was removed in 0.30: a team's provider id is teams.<label>.team (committed, shared) or oats-local.yaml teams.<label>.team (local)" });
  }
  if (isObject(value.tasks)) reservedKeyProblems(value.tasks, "/tasks", problems);
  if (Array.isArray(value.external)) value.external.forEach((entry, i) => {
    if (!isObject(entry)) return;
    if (typeof entry.source === "string") {
      const at = entry.source.lastIndexOf("@");
      if (at > 0) keyOrProblem(remote, entry.source.slice(0, at), `/external/${i}/source`, problems);
    }
  });
  if (isObject(value.defaults)) {
    const d = value.defaults;
    for (const slot of ["knowledge", "messaging", "tasks", "capabilities"]) fromProblems(remote, d[slot], `/defaults/${slot}`, problems, { here: false });
  }
  sharedLabelProblems(value, problems);
  if (isObject(value.sandboxes) && features.includes(SANDBOXES_FEATURE)) problems.push(...workspaceSandboxProblems(value));
  return referenceProblems(withRemovedKeys(problems, value, REMOVED_KEYS.workspace), refFields(value));
}
/** The workspace schema as a kernel with `features` reads it: one without feature sandboxes has no
 *  `sandboxes:` key (an older kernel's refusal, "upgrade OATS" hint included), and one without
 *  sandbox-egress-forge has no egress role `forge`. This kernel lists both; the narrower schemas are how
 *  the rollout rule is pinned (docs/workspaces.md, Sandboxes). */
const featureSchemas = new Map();
function workspaceSchemaFor(features) {
  const sandboxes = features.includes(SANDBOXES_FEATURE), forge = sandboxes && features.includes(SANDBOX_EGRESS_FORGE_FEATURE);
  if (sandboxes && forge) return schemaFor("workspace");
  const key = `${sandboxes}:${forge}`;
  if (!featureSchemas.has(key)) {
    const schema = structuredClone(schemaFor("workspace"));
    if (!sandboxes) delete schema.properties.sandboxes;
    else schema.$defs.sandbox.properties.egress.items.enum = schema.$defs.sandbox.properties.egress.items.enum.filter((r) => r !== "forge");
    featureSchemas.set(key, schema);
  }
  return featureSchemas.get(key);
}
/** An unknown key at the workspace file's root is most often one a newer kernel added (a slot payload, a
 *  new section): the problem says so, beside the schema's own "unknown property" text. Nested keys keep it
 *  bare, and a removed key's own message (withRemovedKeys) replaces it. */
const KERNEL = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
function newerRootKeyHint(problem) {
  if (!/^\/[^/]+$/.test(problem.path) || !problem.message.startsWith("unknown property ")) return problem;
  return { ...problem, reason: "unknown-root-key", message: `${problem.message} — if this is not a typo, the workspace uses a feature newer than this kernel (OATS ${KERNEL}): upgrade OATS` };
}
/** Team model 3: every label `defaultTeam` and `souls:` name is a shared team of this same file, so an
 *  unknown label is refused when the file is read, never at a spawn on someone else's machine. */
function sharedLabelProblems(value, problems) {
  const shared = new Set(isObject(value.teams) ? Object.keys(value.teams) : []);
  const known = (label, path) => { if (typeof label === "string" && !shared.has(label)) problems.push({ path, message: `${show(label)} is not a shared team: declare it in teams: of this file` }); };
  known(value.defaultTeam, "/defaultTeam");
  if (isObject(value.souls)) for (const [key, entry] of Object.entries(value.souls)) {
    if (!isObject(entry)) continue;
    const at = `/souls/${pointerKey(key)}`;
    known(entry.default, `${at}/default`);
    if (Array.isArray(entry.teams)) entry.teams.forEach((label, i) => known(label, `${at}/teams/${i}`));
  }
}
/** A team label as both schemas define it ($defs.label: the pattern, at most 64 characters): null when valid, else
 *  the problem. Every kernel place that accepts a label checks it here, never with its own grammar. */
export function teamLabelProblem(label) {
  const problems = validateAgainst(schemaFor("workspace").$defs.label, label);
  return problems.length ? problems.map((x) => x.message).join("; ") : null;
}
export function validateMembership(value) {
  return referenceProblems(withRemovedKeys(validateAgainst(schemaFor("membership"), value), value, REMOVED_KEYS.membership), [["/workspace", value?.workspace]]);
}

/** Keys 0.30 (team model v2) and 0.38.0 (team model 3) removed: each is a schema problem naming its replacement, in place of
 *  the schema's generic "unexpected property". `at(value)` → the JSON pointers where it appears. */
const REMOVED_KEYS = {
  workspace: [
    { at: (v) => (isObject(v?.defaults) && Object.hasOwn(v.defaults, "byTeam") ? ["/defaults/byTeam"] : []), message: "defaults.byTeam was removed in 0.30: capabilities compose from defaults.capabilities and the soul only" },
    { at: (v) => (Array.isArray(v?.external) ? v.external.flatMap((e, i) => (isObject(e) && Object.hasOwn(e, "team") ? [`/external/${i}/team`] : [])) : []), message: TEAM_MEMBERSHIP_MOVED },
  ],
  membership: [{ at: (v) => (isObject(v) && Object.hasOwn(v, "team") ? ["/team"] : []), message: TEAM_MEMBERSHIP_MOVED }],
  soul: [{ at: (v) => (isObject(v) && Object.hasOwn(v, "team") ? ["/team"] : []), message: TEAM_MEMBERSHIP_MOVED }],
  // 0.38.0 (team model 3): a soul's teams and default are committed in the workspace's souls:.
  local: [
    { at: (v) => (isObject(v?.souls) && Object.hasOwn(v.souls, "teams") ? ["/souls/teams"] : []), message: "souls.teams was removed in 0.38.0 (team model 3): which teams a soul may join is souls: in oats-workspace.yaml" },
    { at: (v) => (isObject(v?.souls) && Object.hasOwn(v.souls, "default") ? ["/souls/default"] : []), message: "souls.default was removed in 0.38.0 (team model 3): a soul's default team is souls: in oats-workspace.yaml (default:)" },
    // 0.52.0: launchPromptAnswers is ignored (core.mjs launchPromptAnswersNotice), except an
    // operator's explicit refusal, which this kernel cannot honour and so must not drop silently.
    { at: (v) => (isObject(v?.launchPromptAnswers?.homes) ? Object.entries(v.launchPromptAnswers.homes)
      .filter(([, e]) => isObject(e) && e.awebDevelopmentChannel === false).map(([home]) => `/launchPromptAnswers/homes/${pointerKey(home)}`) : []),
    message: "launchPromptAnswers awebDevelopmentChannel: false cannot be honoured: OATS confirms Claude's development-channel prompt whenever it launches Claude with --dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace. To keep the prompt unanswered, set settings.oats.aweb.claudeChannelMode: approved in oats-local.yaml, then remove launchPromptAnswers" },
  ],
};
function withRemovedKeys(problems, value, removed) {
  const found = removed.flatMap((r) => r.at(value).map((path) => ({ path, reason: "removed-key", message: r.message })));
  if (!found.length) return problems;
  const paths = new Set(found.map((p) => p.path));
  return [...problems.filter((p) => !paths.has(p.path)), ...found];
}
/** Schema + domain problems for a soul.yaml value: `from:` values must be canonical (see fromProblems);
 * slot payloads may not carry the removed `byTeam` key (see reservedKeyProblems). */
export function validateSoul(value, { remote = defaultRemote } = {}) {
  const problems = withRemovedKeys(validateAgainst(schemaFor("soul"), value), value, REMOVED_KEYS.soul);
  if (isObject(value) && value.schemaVersion === 2) {
    fromProblems(remote, value.capabilities, "/capabilities", problems, { here: true });
    for (const slot of ["knowledge", "messaging", "tasks"]) if (isObject(value[slot])) reservedKeyProblems(value[slot], `/${slot}`, problems);
  }
  const refs = [];
  if (isObject(value?.capabilities)) for (const [name, choice] of Object.entries(value.capabilities)) {
    if (isObject(choice) && typeof choice.from === "string") refs.push([`/capabilities/${pointerKey(name)}/from`, choice.from]);
  }
  return referenceProblems(problems, refs);
}

/** `byTeam` was removed in 0.30 (team model v2): a per-team payload no longer exists — a team's
 * provider id is teams.<label>.team. At the top level of any payload layer (a soul's slot payload,
 * oats-local.yaml settings[cap], a spawn provider) it would reach the provider verbatim as a dead key;
 * refused as a schema problem with `reason: "removed-key"`. Deeper keys are the provider's. */
const REMOVED_PAYLOAD_KEY = "byTeam";
function reservedKeyProblems(payload, path, problems) {
  if (!isObject(payload)) return;
  if (Object.hasOwn(payload, REMOVED_PAYLOAD_KEY)) problems.push({ path: `${path}/${REMOVED_PAYLOAD_KEY}`, reason: "removed-key", message: BY_TEAM_REMOVED });
}

/** `from:` must be exactly what the resolver compares against — "package", "here" (souls only) or a CANONICAL
 * repo key (`parseRepoRef(ref).key`: lowercase host, no scheme, no `git:`, no `.git`, or `local/<abs>`).
 * A key spelled otherwise (git:…, https://…, uppercase host) would pass the schema and fail at spawn with a
 * confusing E_NOT_A_MEMBER; it is a schema problem here instead. */
function fromProblems(remote, capabilities, path, problems, { here }) {
  if (!isObject(capabilities)) return;
  for (const [name, choice] of Object.entries(capabilities)) {
    if (!isObject(choice) || typeof choice.from !== "string") continue;
    const from = choice.from, at = `${path}/${pointerKey(name)}/from`;
    if (from === "package") continue;
    if (from === "here") { if (!here) problems.push({ path: at, message: `"here" is only meaningful in a soul; a workspace default names a repo key or package` }); continue; }
    let key = null;
    try { key = remote.parseRepoRef(from.startsWith("local/") ? from.slice("local/".length) : `git:${from}`).key; } catch {}
    if (key !== from) problems.push({ path: at, message: `${show(from)} is not a canonical repo key (expected <host>/<path> as parseRepoRef(...).key${key ? `, e.g. ${show(key)}` : ""}); \`here\`, \`package\` or a key are the only forms` });
  }
}
/** Schema + domain problems for oats-local.yaml: reserved provider keys and
 * filesystem-dependent canonical home paths supplement the JSON schema. */
export function validateLocal(value) {
  const problems = withRemovedKeys(validateAgainst(schemaFor("local"), value), value, REMOVED_KEYS.local);
  if (isObject(value) && isObject(value.settings)) for (const [cap, payload] of Object.entries(value.settings)) reservedKeyProblems(payload, `/settings/${pointerKey(cap)}`, problems);
  if (isObject(value)) harnessConflictProblems(value["launch-configs"], problems);
  problems.push(...localSandboxProblems(value));
  return referenceProblems(problems, [["/workspace", value?.workspace], ["/standalone", value?.standalone]]);
}
/** runtime → harness (0.27.0, lead call 6): `runtime`, the pre-0.27 name, is still read; both,
 *  disagreeing, are refused. `configs` is a `launch-configs:` block. */
function harnessConflictProblems(configs, problems) {
  if (!isObject(configs)) return;
  for (const [name, entry] of Object.entries(configs)) {
    if (isObject(entry) && Object.hasOwn(entry, "runtime") && Object.hasOwn(entry, "harness") && entry.runtime !== entry.harness) {
      problems.push({ path: `/launch-configs/${pointerKey(name)}/runtime`, reason: "harness-conflict", message: `harness ${show(entry.harness)} and runtime ${show(entry.runtime)} disagree: \`runtime\` is the pre-0.27 name of \`harness\` — keep one` });
    }
  }
}
/** Schema + domain problems for the machine's launch configurations file (awebai/oats#1506): a map whose
 *  one key is `launch-configs:`, validated by oats-local.yaml's schema of that key and the same
 *  runtime/harness check. Any other top-level key is a problem, as is a missing `launch-configs:`. */
export function validateMachineLaunchConfigs(value) {
  if (!isObject(value)) return [{ path: "", message: `expected a map whose one key is launch-configs, got ${value === null || value === undefined ? "an empty document" : typeof value}` }];
  const problems = Object.keys(value).filter((key) => key !== "launch-configs")
    .map((key) => ({ path: `/${pointerKey(key)}`, message: `${show(key)} is not read here: this file holds launch-configs only` }));
  if (!Object.hasOwn(value, "launch-configs")) return [...problems, { path: "", message: "launch-configs is missing: it is this file's one key" }];
  const local = schemaFor("local");
  problems.push(...validateAgainst(local.properties["launch-configs"], value["launch-configs"], { root: local, path: "/launch-configs" }));
  harnessConflictProblems(value["launch-configs"], problems);
  return problems;
}

/* ───────────────────────────── file decoding ──────────────────────────── */

const FILE_KINDS = {
  workspace: { file: "oats-workspace.yaml", validate: validateWorkspace },
  membership: { file: "oats-membership.yaml", validate: validateMembership },
  soul: { file: "soul.yaml", validate: validateSoul },
  local: { file: "oats-local.yaml", validate: validateLocal },
  machine: { file: "launch-configs.yaml", validate: validateMachineLaunchConfigs },
};

/** Decode YAML/JSON bytes into plain data; syntax errors become one problem at "". */
function decodeDocument(bytes, origin) {
  try { return { value: parseConfigData(bytes, { origin }) .value }; }
  catch (e) { return { problems: [{ path: "", message: `cannot decode ${origin.path}: ${e.message}` }] }; }
}
function schemaHint(kind, value) {
  if (isObject(value) && value.schemaVersion !== 2) {
    return ` (this kernel reads ${FILE_KINDS[kind].file} schemaVersion 2 only; found ${show(value.schemaVersion)})`;
  }
  return "";
}
/** Parse + validate a declaration file (`kind` workspace | membership | soul | local) → { value } |
 *  { problems }. Never throws. The reader `oats sync` uses, exported for the repository's validate. */
export function readDeclaration(kind, bytes, origin, validateOptions) {
  const decoded = decodeDocument(bytes, origin);
  if (decoded.problems) return decoded;
  const problems = FILE_KINDS[kind].validate(decoded.value, validateOptions);
  if (problems.length) return { problems, value: decoded.value };
  return { value: decoded.value };
}
function schemaError(kind, origin, problems, value) {
  const where = origin.repoKey ? `${origin.repoKey}@${(origin.commit || "").slice(0, 12)}:${origin.path}` : origin.path;
  // A single-cause refusal (reserved-key, …) surfaces its reason on details for callers that branch on it.
  const reasons = new Set(problems.map((p) => p.reason).filter(Boolean));
  // Team model 3: the refused souls.teams / souls.default come with the souls: that replaces them.
  const moved = kind === "local" && problems.some((p) => p.reason === "removed-key" && /^\/souls\/(teams|default)$/.test(p.path)) ? soulsReplacement(value) : null;
  const replacement = moved ? YAML.stringify(moved, { lineWidth: 0 }) : null;
  return fail("E_WORKSPACE_SCHEMA", `${FILE_KINDS[kind].file} at ${where} is invalid${schemaHint(kind, value)}: ${problems.map((p) => `${p.path || "/"}: ${p.message}`).join("; ")}`
    + (replacement ? `; commit this in oats-workspace.yaml (<member> is the soul's member repository name, as souls.disabled names it), then remove souls.teams and souls.default from oats-local.yaml:\n${replacement}` : ""), {
    path: origin.path, repoKey: origin.repoKey, commit: origin.commit, problems, ...(reasons.size === 1 ? { reason: [...reasons][0] } : {}), ...(replacement ? { replacement } : {}),
  });
}

/* ───────────────────────────── public API ─────────────────────────────── */

/** What a 0.25 `oats-config.yaml` held, and where each piece lives now (0.26.0 removed the file). */
export const LEGACY_CONFIG_MIGRATION = "oats-config.yaml is no longer read (removed in 0.26.0): launch-configs moved to the deployment's oats-local.yaml; "
  + "capability bindings and layers moved to oats-workspace.yaml (defaults) and each soul's soul.yaml in its member repository, and team membership to the deployment's oats-local.yaml (`oats teams`, `oats soul teams`); "
  + "agents-md-injection, skill-overrides, work-modes and yolo are removed (yolo is --yolo or a launch configuration's yolo). Move what you still need, then delete the file";

/** Walk up from dir to find oats-local.yaml → { path, local } | E_LOCAL_MISSING.
 *  A 0.25 `oats-config.yaml` between `dir` and the deployment (inclusive) is refused
 *  (E_CONFIG_BROKEN, naming the migration): nothing reads it, so it must not look
 *  like configuration. Above the deployment is not this deployment's business. */
export function loadLocal(dir) {
  let current = resolve(dir);
  const visited = [], legacy = [];
  for (;;) {
    const candidate = join(current, "oats-local.yaml");
    visited.push(candidate);
    if (existsSync(join(current, "oats-config.yaml"))) legacy.push(join(current, "oats-config.yaml"));
    if (!existsSync(candidate)) recordLocalInput(candidate, null); // a closer file appearing changes the answer
    else {
      if (legacy.length) throw fail("E_CONFIG_BROKEN", `${legacy.join(", ")}: ${LEGACY_CONFIG_MIGRATION}`, { dir: resolve(dir), deployment: current, files: legacy, reason: "legacy-config" });
      const origin = { kind: "local", path: candidate };
      resolvedDeployment(current);
      const bytes = readFileSync(candidate);
      recordLocalInput(candidate, bytes);
      const read = readDeclaration("local", bytes, origin);
      if (read.problems) throw schemaError("local", origin, read.problems, read.value);
      return { path: candidate, local: read.value };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw fail("E_LOCAL_MISSING", `no oats-local.yaml found walking up from ${resolve(dir)}${legacy.length ? ` (${legacy[0]} is a 0.25 deployment's configuration, which 0.26.0 no longer reads: retire its instances with 0.25, then \`oats onboard\` it)` : ""}`, { dir: resolve(dir), searched: visited, ...(legacy.length ? { legacy } : {}) });
}

/** The rules between oats-workspace.yaml and oats-local.yaml (C2.3, C3, C3b: lib/sandbox-model.mjs
 *  crossSandboxProblems), checked wherever both are read (discoverOrStandalone): a local file naming an
 *  undeclared sandbox, or a local team reusing a sandboxed team, is E_WORKSPACE_SCHEMA against
 *  oats-local.yaml. `workspace` null is the standalone view (no sandbox is declared). `localPath`: the
 *  file, for the message. */
export function assertLocalSandboxes(workspace, local, localPath = "oats-local.yaml") {
  const problems = crossSandboxProblems(isObject(workspace) ? workspace : null, local);
  if (problems.length) throw schemaError("local", { kind: "local", path: localPath }, problems, local);
}

/** The machine's launch configurations file at `file` (awebai/oats#1506) → `{ path, configs }`, `configs`
 *  its `launch-configs:` block as written, or null when there is no file. A file that is there but cannot
 *  be read, decoded or validated is E_LAUNCH_CONFIG_INVALID naming it: it is never skipped. */
export function loadMachineLaunchConfigs(file) {
  let bytes;
  try { bytes = readFileSync(file); }
  catch (e) {
    if (e?.code === "ENOENT") { recordLocalInput(file, null); return null; }
    throw fail("E_LAUNCH_CONFIG_INVALID", `the machine's launch configurations ${file} cannot be read (${e?.code || "unreadable"})`, { file });
  }
  recordLocalInput(file, bytes);
  const read = readDeclaration("machine", bytes, { kind: "machine", path: file });
  if (read.problems) throw fail("E_LAUNCH_CONFIG_INVALID", `the machine's launch configurations ${file} are invalid: ${read.problems.map((p) => `${p.path || "/"}: ${p.message}`).join("; ")}`, { file, problems: read.problems });
  return { path: file, configs: read.value["launch-configs"] };
}

/** Observe the workspace host: → { key, url, commit, workspace, observedAt }. */
export async function observeWorkspace(ref, { at, remote: injected, remoteOptions } = {}) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  const obs = await remote.observeRemote(ref, { at });
  const path = "oats-workspace.yaml";
  const origin = { kind: "workspace", repoKey: obs.key, commit: obs.commit, path };
  // The file at the host commit, read and validated (parsed cache item: "missing" or the declaration read).
  const read = await atCommit(remote, ref, obs.commit, "workspace", async () => {
    try { return readDeclaration("workspace", (await remote.readRemoteFile(ref, obs.commit, path)).bytes, origin, { remote }); }
    catch (e) { if (e?.code === "E_REMOTE_PATH_MISSING") return { missing: e.code }; throw e; }
  });
  // Contract: observeWorkspace throws E_REMOTE_UNREADABLE | E_WORKSPACE_SCHEMA. A repo without the
  // file is not a workspace (the usual mistake: a member handed in as the workspace).
  if (read.missing) throw fail("E_WORKSPACE_SCHEMA", `${obs.key}@${obs.commit.slice(0, 12)} has no ${path}: it is not a workspace host`, { path, notAHost: true, repoKey: obs.key, commit: obs.commit, problems: [{ path: "", message: `${path} is missing` }], cause: read.missing });
  if (read.problems) throw schemaError("workspace", origin, read.problems, read.value);
  checkedWorkspace(read.value, remote, []); // validated just now: confirmMembership need not validate it again
  return { key: obs.key, url: obs.url, ref, commit: obs.commit, workspace: read.value, observedAt: obs.observedAt };
}

const unconfirmed = (key, reason, detail, extra = {}) => ({ key, confirmed: false, reason, detail, ...extra });

/** A workspace value's own checks, computed once per workspace object (and parseRepoRef): its problems
 *  and the set of its member keys. confirmMembership runs per member; these do not change between them. */
const workspaceChecks = new WeakMap();
function checkedWorkspace(workspace, remote, knownProblems = null) {
  if (workspace === null || typeof workspace !== "object") return { problems: validateWorkspace(workspace, { remote }), keys: new Set() };
  let byParser = workspaceChecks.get(workspace);
  if (!byParser) workspaceChecks.set(workspace, byParser = new Map());
  let checked = byParser.get(remote.parseRepoRef);
  if (!checked) {
    const keys = new Set();
    for (const m of workspace.members || []) { try { keys.add(refKey(remote, m)); } catch { /* validateWorkspace names it */ } }
    byParser.set(remote.parseRepoRef, checked = { problems: knownProblems ?? validateWorkspace(workspace, { remote }), keys });
  }
  return checked;
}

/** The member's oats-membership.yaml at `commit`, read and validated — a pure function of the bytes there
 *  (parsed cache item "membership"): { kind: "ok", value } | { kind: "invalid", problems } | { kind: "missing" }
 *  | { kind: "unusable", code, message }. E_REMOTE_UNREADABLE (transient) is thrown, never an outcome. */
async function membershipAt(remote, memberRef, key, commit) {
  let bytes;
  try { ({ bytes } = await remote.readRemoteFile(memberRef, commit, "oats-membership.yaml")); }
  catch (e) {
    if (e?.code === "E_REMOTE_PATH_MISSING") return { kind: "missing" };
    if (e?.code === "E_REMOTE_UNREADABLE") throw e;
    if (typeof e?.code === "string" && e.code.startsWith("E_REMOTE_")) return { kind: "unusable", code: e.code, message: e.message };
    throw e;
  }
  const read = readDeclaration("membership", bytes, { kind: "membership", repoKey: key, commit, path: "oats-membership.yaml" });
  return read.problems ? { kind: "invalid", problems: read.problems } : { kind: "ok", value: read.value };
}

/**
 * Read the member's oats-membership.yaml at its default branch in the same access context.
 * → { key, commit, confirmed: true } | { key, confirmed: false, reason, detail }
 */
export async function confirmMembership(workspaceObs, memberRef, { remote: injected, remoteOptions } = {}) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  const workspace = workspaceObs.workspace;
  const checked = checkedWorkspace(workspace, remote);
  if (checked.problems.length) throw schemaError("workspace", { kind: "workspace", repoKey: workspaceObs.key, commit: workspaceObs.commit, path: "oats-workspace.yaml" }, checked.problems, workspace);
  let key;
  try { key = refKey(remote, memberRef); }
  catch (e) {
    if (e?.code === "E_REPO_REF") return unconfirmed(defaultRemote.displayRepoRef(typeof memberRef === "string" ? memberRef : String(memberRef)), "not-listed", `${show(defaultRemote.displayRepoRef(memberRef))} is not a repo ref: ${e.message}`);
    throw e;
  }
  if (!checked.keys.has(key)) return unconfirmed(key, "not-listed", `${key} is not in members of workspace ${workspaceObs.key}`);
  const cannotRead = (e) => {
    const url = defaultRemote.displayRepoRef(e.details?.url ?? e.provenance?.url ?? null);
    return unconfirmed(key, "cannot-read", `cannot read ${url ?? defaultRemote.displayRepoRef(memberRef)}${e.details?.reason ? ` (${e.details.reason})` : ""}`, { url });
  };
  let obs;
  try { obs = await remote.observeRemote(memberRef); }
  catch (e) {
    if (e?.code === "E_REMOTE_UNREADABLE") return cannotRead(e);
    throw e;
  }
  let outcome;
  try { outcome = await atCommit(remote, memberRef, obs.commit, "membership", () => membershipAt(remote, memberRef, key, obs.commit)); }
  catch (e) {
    if (e?.code === "E_REMOTE_UNREADABLE") return cannotRead(e);
    throw e;
  }
  if (outcome.kind === "missing") return unconfirmed(key, "no-backlink", `${key}@${obs.commit.slice(0, 12)} has no oats-membership.yaml`, { commit: obs.commit });
  // Contract: NEVER throws for an unconfirmed member. Anything else the remote refuses about the
  // member's file (oversize, symlink, unsafe tree) means the repo has not completed the handshake.
  if (outcome.kind === "unusable") return unconfirmed(key, "no-backlink", `${key}@${obs.commit.slice(0, 12)} oats-membership.yaml cannot be used: ${outcome.message}`, { commit: obs.commit, cause: outcome.code });
  const read = outcome.kind === "invalid" ? { problems: outcome.problems } : { value: outcome.value };
  if (read.problems) return unconfirmed(key, "no-backlink", `${key}@${obs.commit.slice(0, 12)} oats-membership.yaml is invalid: ${read.problems.map((p) => `${p.path || "/"}: ${p.message}`).join("; ")}`, { commit: obs.commit, problems: read.problems });
  let backlinkKey;
  try { backlinkKey = refKey(remote, read.value.workspace); }
  catch (e) {
    if (e?.code === "E_REPO_REF") return unconfirmed(key, "no-backlink", `${key}@${obs.commit.slice(0, 12)} oats-membership.yaml names an unparseable workspace ${show(defaultRemote.displayRepoRef(read.value.workspace))}`, { commit: obs.commit });
    throw e;
  }
  if (!sameRepo(backlinkKey, workspaceObs.key)) {
    const caseOnly = backlinkKey.toLowerCase() === workspaceObs.key.toLowerCase();
    return unconfirmed(key, "backlink-elsewhere", `${key}@${obs.commit.slice(0, 12)} names workspace ${backlinkKey}, not ${workspaceObs.key}${caseOnly ? " (the keys differ only by letter case: repo paths are case-sensitive identities; spell the workspace ref exactly as the workspace lists itself)" : ""}`, { commit: obs.commit, backlink: backlinkKey, ...(caseOnly ? { caseOnly: true } : {}) });
  }
  return { key, commit: obs.commit, confirmed: true };
}

/* ───────────────────────────── enumeration ────────────────────────────── */

/** The conventional directory shared by discovery and reads at a recorded soul commit. */
export const memberSoulPath = (name) => `souls/${name}`;

const SOUL_FILE = /^([^/]+)\/soul\.yaml$/;
const CAP_FILE = /^([^/]+)\/oats\.json$/;

/**
 * Enumerate souls/*\/soul.yaml and capabilities/*\/oats.json of one repo at one commit.
 * Validates each item; collects problems instead of aborting.
 * → { souls: [SoulEntry], capabilities: [CapEntry], problems: [{ code, path, message, repoKey }],
 *     soulsSkipped: [path] }: where a soul may exist and is not in `souls` (the souls/ listing failed, or
 *     a soul.yaml could not be read or is invalid). `problems` says why; this says that a soul is missing.
 */
async function enumerateRepo(remote, ref, key, commit) {
  const souls = [];
  const capabilities = [];
  const problems = [];
  const soulsSkipped = [];
  const problem = (code, path, message) => problems.push({ code, repoKey: key, path, message });
  // A listing failure on one directory is a problem of THIS repo, never an abort of the whole picture.
  const list = async (dir) => {
    try { return await remote.listRemoteTree(ref, commit, dir, { depth: 2 }); }
    catch (e) {
      if (typeof e?.code === "string" && e.code.startsWith("E_REMOTE_")) { problem(e.code, dir, e.message); if (dir === "souls") soulsSkipped.push(dir); return []; }
      throw e;
    }
  };
  const soulNames = new Map();
  for (const entry of await list("souls")) {
    const m = entry.type === "blob" && SOUL_FILE.exec(entry.path);
    if (!m) continue;
    const path = memberSoulPath(m[1]);
    const file = `${path}/soul.yaml`;
    let bytes;
    try { ({ bytes } = await remote.readRemoteFile(ref, commit, file)); }
    catch (e) { problem(e?.code || "E_REMOTE_UNREADABLE", file, e.message); soulsSkipped.push(file); continue; }
    const read = readDeclaration("soul", bytes, { kind: "soul", repoKey: key, commit, path: file });
    if (read.problems) { for (const p of read.problems) problem("E_WORKSPACE_SCHEMA", `${file}#${p.path}`, `${p.message}${schemaHint("soul", read.value)}`); soulsSkipped.push(file); continue; }
    const definition = read.value;
    if (definition.name !== m[1]) problem("E_WORKSPACE_SCHEMA", `${file}#/name`, `soul name ${show(definition.name)} does not match its directory ${show(m[1])}`);
    // (A second declaration of a name is not a missing soul: the first one is listed under that name.)
    if (soulNames.has(definition.name)) { problem("E_WORKSPACE_SCHEMA", `${file}#/name`, `soul name ${show(definition.name)} is already declared by ${soulNames.get(definition.name)}; the second declaration is not listed`); continue; }
    soulNames.set(definition.name, file);
    // Souls have no private mode since 0.26.0: `private` is accepted, warned (soul-private-ignored) and never hides a soul.
    souls.push({ name: definition.name, path, repoKey: key, commit, private: false, definition });
  }
  const capNames = new Map();
  for (const entry of await list("capabilities")) {
    const m = entry.type === "blob" && CAP_FILE.exec(entry.path);
    if (!m) continue;
    const path = `capabilities/${m[1]}`;
    const file = `${path}/oats.json`;
    let bytes;
    try { ({ bytes } = await remote.readRemoteFile(ref, commit, file)); }
    catch (e) { problem(e?.code || "E_REMOTE_UNREADABLE", file, e.message); continue; }
    const decoded = decodeDocument(bytes, { kind: "capability", repoKey: key, commit, path: file });
    if (decoded.problems) { for (const p of decoded.problems) problem("E_WORKSPACE_SCHEMA", `${file}#${p.path}`, p.message); continue; }
    const manifest = decoded.value;
    // The fields discovery relies on. `capability` uses the SAME grammar as every `capabilities:` key
    // in soul.yaml / oats-workspace.yaml (capabilityName): a name that cannot be referenced is not
    // discoverable, and a name with `/` or `..` never becomes a module directory.
    const shape = validateAgainst({
      type: "object", required: ["capability", "version"],
      properties: {
        capability: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        version: { type: "string", minLength: 1 },
        private: { type: "boolean" },
        layer: { enum: ["knowledge", "messaging", "tasks"] },
      },
    }, manifest);
    if (shape.length) { for (const p of shape) problem("E_WORKSPACE_SCHEMA", `${file}#${p.path}`, p.message); continue; }
    // The kernel contract (launch environment, hooks): a manifest the kernel could not run is not listed.
    // What it declares and this kernel ignores (an unknown hook event) is a warning (workspaceWarnings), not a problem.
    const contract = manifestContractProblems(manifest);
    if (contract.length) { for (const p of contract) problem("E_WORKSPACE_SCHEMA", `${file}#${p.pointer}`, p.message); continue; }
    if (capNames.has(manifest.capability)) { problem("E_WORKSPACE_SCHEMA", `${file}#/capability`, `capability ${show(manifest.capability)} is already declared by ${capNames.get(manifest.capability)}; the second declaration is not listed`); continue; }
    capNames.set(manifest.capability, file);
    capabilities.push({ name: manifest.capability, path, repoKey: key, commit, private: manifest.private === true, manifest });
  }
  // Non-collapse rule: a member's oats-package/ is REPORTED (publishes), never enumerated as member capabilities.
  let publishes = null;
  try {
    const { bytes } = await remote.readRemoteFile(ref, commit, "oats-package/oats-package.json");
    const decoded = decodeDocument(bytes, { kind: "package", repoKey: key, commit, path: "oats-package/oats-package.json" });
    if (decoded.problems) for (const p of decoded.problems) problem("E_WORKSPACE_SCHEMA", `oats-package/oats-package.json#${p.path}`, p.message);
    else if (isObject(decoded.value) && typeof decoded.value.package === "string") publishes = { package: decoded.value.package, version: typeof decoded.value.version === "string" ? decoded.value.version : null };
    else problem("E_WORKSPACE_SCHEMA", "oats-package/oats-package.json#/package", "package manifest must declare \"package\"");
  } catch (e) {
    if (e?.code !== "E_REMOTE_PATH_MISSING") {
      if (typeof e?.code === "string" && e.code.startsWith("E_REMOTE_")) problem(e.code, "oats-package/oats-package.json", e.message);
      else throw e;
    }
  }
  return { souls, capabilities, publishes, problems, soulsSkipped };
}

/**
 * Enumerate one readable repo without a workspace view (the standalone input):
 * → { key, commit, membership: <parsed or null>, souls, capabilities, problems }
 */
export async function discoverRepo(ref, { at, remote: injected, remoteOptions } = {}) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  const obs = await remote.observeRemote(ref, { at });
  let membership = null;
  const problems = [];
  try {
    const { bytes } = await remote.readRemoteFile(ref, obs.commit, "oats-membership.yaml");
    const read = readDeclaration("membership", bytes, { kind: "membership", repoKey: obs.key, commit: obs.commit, path: "oats-membership.yaml" });
    if (read.problems) for (const p of read.problems) problems.push({ code: "E_WORKSPACE_SCHEMA", repoKey: obs.key, path: `oats-membership.yaml#${p.path}`, message: p.message });
    else membership = read.value;
  } catch (e) {
    if (e?.code !== "E_REMOTE_PATH_MISSING") throw e;
  }
  const items = await atCommit(remote, ref, obs.commit, "enumerate", () => enumerateRepo(remote, ref, obs.key, obs.commit));
  return { key: obs.key, commit: obs.commit, membership, ...items, problems: [...problems, ...items.problems] };
}

/** The agents-root directory (and agent name) of a package soul: `<package>--<soul>`, the package id
 *  with every character outside [a-z0-9-] as `-` (`oats.okf/knowledge-maintainer` →
 *  `oats-okf--knowledge-maintainer`). A soul name is a slug and never holds `--`, so this can never be
 *  a member soul's directory; instances are named by the slug of it (`oats-okf-knowledge-maintainer-<purpose>`). */
export const PACKAGE_SOUL_SEPARATOR = "--";
export function packageSoulAgentName(id, soul) { return `${String(id).replace(/[^a-z0-9-]/g, "-")}${PACKAGE_SOUL_SEPARATOR}${soul}`; }

/**
 * Package souls (0.28.0): the souls the lock records for each package the workspace STILL declares,
 * read at the locked commit. A package soul is listed like a member soul, with its package origin
 * (`package`, `version`) and its qualified name `<package>/<soul>`. A package soul.yaml still carrying
 * `team:` (removed in 0.30: team membership is local) is invalid and not listed.
 * Nothing here trusts the lock's digests — a spawn verifies the fetched soul against them.
 * `lock` null (or no workspace) → nothing. → { souls: [SoulEntry], problems, skipped: [package id] }:
 * `skipped` names each package with a soul the lock records and this read does not list.
 */
export async function discoverPackageSouls(workspace, lock, { remote: injected, remoteOptions } = {}) {
  const souls = [], problems = [], skipped = new Set();
  if (!isObject(lock?.packages) || !isObject(workspace)) return { souls, problems, skipped: [] };
  const remote = remoteOf({ remote: injected, remoteOptions });
  const declared = isObject(workspace.packages) ? workspace.packages : {};
  for (const id of Object.keys(lock.packages).sort()) {
    const entry = lock.packages[id];
    if (!Array.isArray(entry?.souls) || entry.souls.length === 0 || !Object.hasOwn(declared, id)) continue;
    const at = (rel) => `package:${id}:${rel}`;
    const problem = (code, path, message) => problems.push({ code, repoKey: null, package: id, path: at(path), message });
    const ref = lockedPackageRef(entry);
    if (!ref) { problem("E_PACKAGE_MISSING", entry.path, `the lock records no url for ${id} — run \`oats sync\``); skipped.add(id); continue; }
    let key;
    try { key = remote.parseRepoRef(ref).key; }
    catch (e) { if (e?.code === "E_REPO_REF") { problem("E_REPO_REF", entry.path, e.message); skipped.add(id); continue; } throw e; }
    for (const locked of entry.souls) {
      const path = `${entry.path}/${locked.path}`;
      const file = `${path}/soul.yaml`;
      // soul.yaml at the locked commit, read and validated (parsed cache item; a remote failure is an
      // outcome here, and a transient one is never kept).
      const read = await atCommit(remote, ref, entry.commit, `package-soul\0${file}`, async () => {
        try { return readDeclaration("soul", (await remote.readRemoteFile(ref, entry.commit, file)).bytes, { kind: "soul", repoKey: key, commit: entry.commit, path: file }); }
        catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_REMOTE_")) return { remoteError: { code: e.code, message: e.message } }; throw e; }
      });
      if (read.remoteError) { problem(read.remoteError.code, file, read.remoteError.message); skipped.add(id); continue; }
      if (read.problems) { for (const p of read.problems) problem("E_WORKSPACE_SCHEMA", `${file}#${p.path}`, `${p.message}${schemaHint("soul", read.value)}`); skipped.add(id); continue; }
      const definition = read.value;
      if (definition.name !== locked.name) { problem("E_WORKSPACE_SCHEMA", `${file}#/name`, `soul name ${show(definition.name)} does not match its directory ${show(locked.name)}`); skipped.add(id); continue; }
      souls.push({
        name: locked.name, path, repoKey: key, ref, commit: entry.commit, private: false, definition,
        package: id, version: entry.version, qualifiedName: `${id}/${locked.name}`, agentName: packageSoulAgentName(id, locked.name), digest: locked.digest,
      });
    }
  }
  // Two packages whose ids differ only where the directory name sanitises (`a.b`, `a-b`) and that
  // ship a same-named soul would share one agent directory: both are listed, neither is spawnable.
  const byDir = new Map();
  for (const s of souls) byDir.set(s.agentName, [...(byDir.get(s.agentName) || []), s]);
  for (const [dir, group] of byDir) {
    if (group.length < 2) continue;
    const qualified = group.map((s) => s.qualifiedName).sort();
    for (const s of group) {
      s.collides = qualified;
      problems.push({ code: "E_SOUL_AMBIGUOUS", repoKey: null, package: s.package, path: `package:${s.package}:${s.path}/soul.yaml`, message: `package souls ${qualified.join(" and ")} would share the agent directory agents/${dir}/ — keep one of the packages in packages:` });
    }
  }
  return { souls, problems, skipped: [...skipped] };
}

/** The packages the workspace declares and `lock` does not hold (declared, and `oats sync` not run since), by id. */
export function unlockedPackages(workspace, lock) {
  const locked = isObject(lock?.packages) ? lock.packages : {};
  return Object.keys(isObject(workspace?.packages) ? workspace.packages : {}).filter((id) => !Object.hasOwn(locked, id)).sort();
}

/** Members discovered at once (a fixed bound: the laptop's git and network, not the workspace's size). */
export const DISCOVERY_CONCURRENCY = 8;

/** `task(item, index)` over `items` with at most `limit` running, results in item order. Exactly the serial
 *  loop's outcome: indices are taken in order, nothing new starts after a failure, and the failure of the
 *  LOWEST index is thrown once everything started has settled (every earlier item had succeeded). */
async function boundedMap(items, limit, task) {
  const results = new Array(items.length);
  const failures = new Map();
  let next = 0;
  const worker = async () => {
    while (next < items.length && failures.size === 0) {
      const i = next++;
      try { results[i] = await task(items[i], i); } catch (e) { failures.set(i, e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.size) throw failures.get(Math.min(...failures.keys()));
  return results;
}

/**
 * The whole picture in one access context.
 * → { workspace, members: [{ key, commit, confirmed, reason?, souls, capabilities, publishes }], external: [...],
 *     problems: [{ code, path, message, repoKey? }], soulsUnread }
 * `soulsUnread` is where this read may be missing a soul, for the readers of oats-local.yaml souls.launch
 * (lib/instance-resolution.mjs soulsOffered): { members: [repo key] (a confirmed member with a soul skipped,
 * or whose enumeration carries no record of what it skipped: skippedSome),
 * external: [source] (an external soul skipped), packages: [id] (a locked package with a soul skipped),
 * unlocked: [id] (a package the workspace declares and `lock` does not hold) }. It is no part of any
 * JSON answer: `problems` rows keep their fields.
 * `publishes` = { package, version } when the member carries oats-package/oats-package.json (informational:
 * the package's capabilities are NOT member capabilities — non-collapse rule), else null.
 * Members are read DISCOVERY_CONCURRENCY at a time; rows and problems are assembled in declaration order.
 */
export async function discoverWorkspace(ref, { at, local, lock = null, remote: injected, remoteOptions } = {}) {
  const remote = remoteOf({ remote: injected, remoteOptions });
  prefetchMembers(remote, ref, at);
  let wsObs;
  // The host cannot be observed: nothing will adopt the prefetches, so none still queued may run its git.
  try { wsObs = await observeWorkspace(ref, { at, remote }); }
  catch (e) { remote.abandonPrefetches?.(); throw e; }
  const workspace = wsObs.workspace;
  const problems = [];
  const members = [];
  let discovered;
  try {
    discovered = await boundedMap(workspace.members || [], DISCOVERY_CONCURRENCY, async (memberRef) => {
      const confirmation = await confirmMembership(wsObs, memberRef, { remote });
      const row = { key: confirmation.key, ref: memberRef, commit: confirmation.commit ?? null, confirmed: confirmation.confirmed, souls: [], capabilities: [], publishes: null };
      if (!confirmation.confirmed) {
        // Contract: an unconfirmed member contributes nothing but its row.
        row.reason = confirmation.reason;
        row.detail = confirmation.detail;
        return { row, problems: [] };
      }
      const items = await atCommit(remote, memberRef, row.commit, "enumerate", () => enumerateRepo(remote, memberRef, row.key, row.commit));
      row.souls = items.souls;
      row.capabilities = items.capabilities;
      row.publishes = items.publishes;
      return { row, problems: items.problems, skipped: skippedSome(items.soulsSkipped) };
    });
  } finally {
    // Every member listed now has adopted its prefetch (or the discovery failed): the rest, members dropped
    // since the host's last observed commit, are given up.
    remote.abandonPrefetches?.();
  }
  const soulsUnread = { members: [], external: [], packages: [], unlocked: [] };
  // An unconfirmed member carries no enumeration at all: its row says so, and it is not "skipped" here.
  for (const d of discovered) { members.push(d.row); problems.push(...d.problems); if (d.skipped) soulsUnread.members.push(d.row.key); }
  const externalRows = [];
  for (const [index, entry] of (workspace.external || []).entries()) {
    const pin = entry.source.lastIndexOf("@");
    const sourceRef = entry.source.slice(0, pin);
    const commit = entry.source.slice(pin + 1);
    const file = `${entry.soul.replace(/\/+$/, "")}/soul.yaml`;
    const pushProblem = (code, path, message) => { problems.push({ code, repoKey: null, path: `external/${index}:${path}`, message, source: defaultRemote.displayRepoRef(entry.source, { pinned: { ref: sourceRef, commit } }) }); if (!soulsUnread.external.includes(entry.source)) soulsUnread.external.push(entry.source); };
    let key;
    try { key = refKey(remote, sourceRef); }
    catch (e) { if (e?.code === "E_REPO_REF") { pushProblem("E_REPO_REF", "source", e.message); continue; } throw e; }
    // Pinned: read at the declared OID only; the remote's default branch is never consulted. The soul.yaml
    // there, read and validated, is a parsed cache item (a transient failure is never kept).
    const read = await atCommit(remote, sourceRef, commit, `external-soul\0${file}`, async () => {
      try { return readDeclaration("soul", (await remote.readRemoteFile(sourceRef, commit, file)).bytes, { kind: "soul", repoKey: key, commit, path: file }); }
      catch (e) { if (e?.code === "E_REMOTE_UNREADABLE" || e?.code === "E_REMOTE_PATH_MISSING") return { remoteError: { code: e.code, message: e.message } }; throw e; }
    });
    if (read.remoteError) { pushProblem(read.remoteError.code, file, read.remoteError.message); continue; }
    if (read.problems) { for (const p of read.problems) pushProblem("E_WORKSPACE_SCHEMA", `${file}#${p.path}`, `${p.message}${schemaHint("soul", read.value)}`); continue; }
    externalRows.push({ source: entry.source, key, commit, soul: { name: read.value.name, path: entry.soul, repoKey: key, commit, private: false, definition: read.value } });
  }
  const pkg = await discoverPackageSouls(workspace, lock, { remote });
  problems.push(...pkg.problems);
  soulsUnread.packages = pkg.skipped;
  soulsUnread.unlocked = unlockedPackages(workspace, lock);
  return { workspace, key: wsObs.key, url: wsObs.url, commit: wsObs.commit, observedAt: wsObs.observedAt, local: local ?? null, members, external: externalRows, packageSouls: pkg.souls, problems, soulsUnread, warnings: workspaceWarnings(workspace, members, externalRows, pkg.souls) };
}

/**
 * The member prefetch (spec Addendum 3): a whole-workspace discovery starts its members' head observations
 * together with the host's instead of one network round after it. The member list is the one at the host's
 * LAST observed commit (its observation record, of any age) as the parsed cache holds it — no git process
 * decides anything here; either missing or corrupt means no prefetch. The host goes first (the session's
 * observation slots are handed out in order). Only discoverWorkspace calls this: observeWorkspace alone (the
 * teams reads, inspect --home) never fires member observations it would not use. Truth is unchanged: the
 * members the answer uses come from the workspace file at the host commit observed NOW, each confirmed at
 * its own observed commit; a member no longer listed costs one unused observation and is never read.
 */
function prefetchMembers(remote, ref, at) {
  if (typeof remote.lastObservedCommit !== "function" || typeof remote.peekAtCommit !== "function" || typeof remote.prefetchObservation !== "function") return;
  const commit = remote.lastObservedCommit(ref, { at });
  if (!commit) return;
  const read = remote.peekAtCommit(ref, commit, "workspace");
  if (!read || typeof read !== "object" || read.missing || read.problems || !Array.isArray(read.value?.members)) return;
  remote.prefetchObservation(ref, { at });
  for (const member of read.value.members) if (typeof member === "string") remote.prefetchObservation(member);
}

/** A discovery's member row by key: the FIRST row with that key, as `find` would give, from an index built
 *  once per members array (resolve, materialize and the CLI's facts look rows up per soul, capability and
 *  instance: a scan each was O(rows × members)). A discovery's members array is never edited after
 *  discoverWorkspace returns it. The two spellings of a moved repository find one row (lib/repo-moves.mjs):
 *  a home records the key it was spawned under. */
const memberRowIndex = new WeakMap();
export function memberRowByKey(members, key) {
  if (!Array.isArray(members)) return null;
  let index = memberRowIndex.get(members);
  if (!index) {
    index = new Map();
    for (const m of members) if (m && !index.has(currentRepoKey(m.key))) index.set(currentRepoKey(m.key), m);
    memberRowIndex.set(members, index);
  }
  return index.get(currentRepoKey(key)) ?? null;
}

/** The discovery's warnings: ignored `private:`, over every listed soul, then what a listed
 *  member capability declares and this kernel ignores (capabilityContractWarnings). (0.30
 *  removed the `unmapped-team-label` warning: an unmapped shared team is the readiness item
 *  `team-unmapped`.) */
const byCodepointOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function workspaceWarnings(workspace, members, externalRows, packageSouls) {
  const confirmed = members.filter((m) => m.confirmed);
  return [
    ...privateSoulWarnings([...confirmed.flatMap((m) => m.souls), ...externalRows.map((e) => e.soul), ...(packageSouls || [])]),
    ...capabilityContractWarnings(confirmed.flatMap((m) => m.capabilities)),
  ];
}

/** Listed member capabilities' contract warnings (lib/capability-contract.mjs: an unknown,
 *  non-required hook event), ONE per warning: { code, capability, path, message }, `path`
 *  `<repoKey>:<dir>/oats.json#<pointer>`, sorted by capability, then path. */
export function capabilityContractWarnings(capabilities) {
  return capabilities.flatMap((c) => locatedContractWarnings(c.manifest, `${c.repoKey}:${c.path}/oats.json`))
    .sort((a, b) => byCodepointOrder(a.capability, b.capability) || byCodepointOrder(a.path, b.path));
}

/** `private:` in a soul.yaml has no effect since 0.26.0 (human decision 2026-09-25): every soul of a
 *  confirmed member, and every external soul, is listed and spawnable. The field is still ACCEPTED
 *  (existing files keep validating) and named by ONE warning per soul that carries it:
 *  { code: "soul-private-ignored", soul, repoKey, path, message }, sorted by soul name, then path. */
function privateSoulWarnings(souls) {
  return souls.filter((s) => s.definition && Object.hasOwn(s.definition, "private"))
    .map((s) => ({ code: "soul-private-ignored", soul: s.name, repoKey: s.repoKey, path: `${s.repoKey}:${s.path}/soul.yaml#/private`,
      message: `\`private\` has no effect on a soul since 0.26.0; remove it from ${s.path}/soul.yaml` }))
    .sort((a, b) => byCodepointOrder(a.soul, b.soul) || byCodepointOrder(a.path, b.path));
}

/**
 * For a readable MEMBER whose workspace cannot be read (decision 10): its souls with from:here
 * capabilities only. `discovery` is the repo's own enumeration (discoverRepo(...) or a
 * discoverWorkspace(...) result containing the repo); workspace defaults do not apply and are
 * not known here. Membership itself (oats-membership.yaml present) is the CALLER's gate —
 * discoverOrStandalone refuses a repo with no backlink (E_MEMBERSHIP_UNCONFIRMED no-backlink)
 * before ever building this view.
 */
/** The capability every standalone spawn gets by default (decision 25). */
export const STANDALONE_DEFAULT_CAPABILITY = "oats.core";
export function standaloneRepo(ref, commit, discovery, { remote: injected } = {}) {
  const remote = remoteOf({ remote: injected });
  const key = refKey(remote, ref);
  if (!discovery) throw fail("E_MEMBERSHIP_UNCONFIRMED", `standaloneRepo needs the repo's enumeration (discoverRepo) for ${key}`, { key, commit, reason: "cannot-read" });
  const source = Array.isArray(discovery.members) ? discovery.members.find((m) => sameRepo(m.key, key)) : discovery;
  if (!source || (source.key && !sameRepo(source.key, key))) throw fail("E_MEMBERSHIP_UNCONFIRMED", `discovery does not describe ${key}`, { key, commit, reason: "cannot-read" });
  if (source.commit && commit && source.commit !== commit) throw fail("E_MEMBERSHIP_UNCONFIRMED", `discovery of ${key} is at ${source.commit}, not ${commit}`, { key, commit, observed: source.commit, reason: "cannot-read" });
  const problems = [];
  const capabilities = (source.capabilities || []).filter((c) => sameRepo(c.repoKey, key));
  const capNames = new Set(capabilities.map((c) => c.name));
  const souls = (source.souls || []).filter((s) => sameRepo(s.repoKey, key)).map((soul) => {
    // Decision 25: the framework's own operational package is the kernel's default
    // even when the workspace (and its defaults) cannot be read. ANY mention of
    // oats.core in the soul — `{ from: package }`, `{ from: here }`, `{ from: <repo> }`
    // or `off` — suppresses the kernel default: the soul's own choice is then judged
    // by the loop below exactly like every other capability (S4). The default is added
    // after the soul's own entries, so its instructions follow theirs, as any default's do.
    const kept = {};
    const declaredCaps = soul.definition.capabilities || {};
    for (const [name, choice] of Object.entries(declaredCaps)) {
      const from = isObject(choice) ? choice.from : null;
      if (choice === "off") continue;
      if (from === "here" || sameRepo(from, key)) {
        if (!capNames.has(name)) problems.push({ code: "E_CAPABILITY_MISSING", repoKey: key, path: `${soul.path}/soul.yaml#/capabilities/${pointerKey(name)}`, message: `${key} has no capabilities/*/oats.json declaring ${show(name)}` });
        else kept[name] = { from: "here" };
      } else if (from === "package") {
        // The operator's lock (oats sync against a catalog) is where package
        // capabilities resolve; standalone, only the kernel default is honoured.
        if (name === STANDALONE_DEFAULT_CAPABILITY) { kept[name] = { from: "package" }; continue; }
        problems.push({ code: "E_PACKAGE_MISSING", repoKey: key, path: `${soul.path}/soul.yaml#/capabilities/${pointerKey(name)}`, message: `${show(name)} comes from a package, but the workspace's packages cannot be read standalone` });
      } else {
        problems.push({ code: "E_NOT_A_MEMBER", repoKey: key, path: `${soul.path}/soul.yaml#/capabilities/${pointerKey(name)}`, message: `${show(name)} comes from ${show(from)}, which cannot be confirmed as a member without the workspace` });
      }
    }
    if (!Object.hasOwn(declaredCaps, STANDALONE_DEFAULT_CAPABILITY)) kept[STANDALONE_DEFAULT_CAPABILITY] = { from: "package" };
    return { ...soul, capabilities: kept };
  });
  return {
    standalone: true, key, commit: source.commit ?? commit ?? null, workspace: null,
    members: [{ key, commit: source.commit ?? commit ?? null, confirmed: false, reason: "cannot-read", detail: `workspace of ${key} cannot be read; standalone view`, souls, capabilities, publishes: source.publishes ?? null }],
    external: [], problems, warnings: [...privateSoulWarnings(souls), ...capabilityContractWarnings(capabilities)],
    // As discoverWorkspace's: the repo's own souls are all this view offers, so only they can be missing.
    // A discovery or an enumeration with no record of it counts as one with a soul skipped (skippedSome).
    soulsUnread: { members: (Array.isArray(discovery.members) ? (!Array.isArray(discovery.soulsUnread?.members) || discovery.soulsUnread.members.includes(key)) : skippedSome(source.soulsSkipped)) ? [key] : [], external: [], packages: [], unlocked: [] },
  };
}
