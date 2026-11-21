/** What the kernel runs of a provider home (docs/capabilities.md "What the kernel trusts in a
 *  provider home"; the contract's D16 rule 3).
 *
 *  A home on a session provider can be written by its own agent: the provider may run the harness
 *  in a sandbox that still writes the home, and the kernel that runs the home's hooks and its
 *  provider's commands runs outside any sandbox, as the operator, WHILE that agent runs. So for
 *  such a home the kernel runs nothing that is in the home, and takes no capability setting from it:
 *
 *  - the kernel keeps its OWN copy of the home's modules, outside the home, beside the home's
 *    receipt (`<instances>/.oats-retirement/modules/<hash of the home>/<store>/<capability>/`):
 *    made by the spawn from the copies it materialised, before the provider is asked anything
 *    and before any hook of the spawn runs.
 *    `oats instance upgrade` makes a new one beside it (another `<store>`) and the receipt's one
 *    write then names it, with the rows that go with it: an upgrade that fails before that write
 *    leaves the old copy and the old rows, together; after it, the new ones. Every hook,
 *    every command of the provider, every readiness check and every dispatched command of such a
 *    home is run from there, and its manifests are read there. The copies in the home are the
 *    agent's own (its skills, what its harness runs inside its sandbox): the kernel never runs
 *    them, so nothing the agent does to them, at any moment, changes what the kernel runs;
 *  - the home's receipt (lib/session-receipt.mjs) carries its `composition`: which store holds
 *    the kernel's copies, which modules the home has and where each came from, and the
 *    capability rows the spawn resolved from the
 *    deployment (settings, their origins, levels, and the hook commands, which name the kernel's
 *    copy). A capability's row is the receipt's, never instance.json's `capabilityRuntime`.
 *
 *  Why a copy and not a check: a copy in the home that is hashed and then run can be exchanged
 *  between the two by the session that writes the home, for as long as the command takes to
 *  start and for as long as it runs.
 *
 *  A tmux home is unchanged, and why: its agent already runs unsandboxed as the operator, and can
 *  do directly whatever a module it rewrote could. This protects nothing against an agent that
 *  can write outside its home: a provider that sandboxes keeps `<instances>/.oats-retirement/`
 *  unwritable.
 *
 *  A leaf: it reads and copies files, and knows nothing of sessions or of core.mjs. */
import { cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { homeModulesStore, homeReceipt, isPlainObject, readJsonOrUndefined } from "./session-receipt.mjs";

/** What a row's `moduleCopy.differs` may name: capability ids (the manifest grammar's), each of
 *  at most this length, and at most this many. */
const MODULE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MODULE_COPY_ID_MAX = 200, MODULE_COPY_IDS_MAX = 200;
/** The version of a receipt's `composition`. */
export const COMPOSITION_VERSION = 1;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Where a home keeps ITS copy of capability `id` (the agent's own). */
const homeModuleDir = (home, id) => join(home, ".oats", "modules", id);
const STORE_RE = /^[a-f0-9]{12}$/;
/** Where the kernel keeps its copy of capability `id` of the home `home`, which is what it runs:
 *  in the store the home's receipt names (`trust`: providerHomeTrust's answer, read here when it
 *  is not given). A path that does not exist when the receipt names no store. */
export function kernelModuleDir(home, id, trust = providerHomeTrust(home)) {
  return kernelModuleDirIn(home, trust?.composition?.store ?? "-", id);
}
/** The same, in the store named `store`: the one a receipt is about to name (an upgrade's new
 *  one), or named before (the one an undo goes back to). */
export const kernelModuleDirIn = (home, store, id) => join(homeModulesStore(home), store, id);
/** The home a module copy belongs to, when `dir` is `<home>/.oats/modules/<id>`: `{ home, id }`,
 *  else null (a deployment's own module store, a soul's tree, the kernel's own copy). */
export function homeOfModuleCopy(dir) {
  if (typeof dir !== "string" || basename(dirname(dir)) !== "modules" || basename(dirname(dirname(dir))) !== ".oats") return null;
  return { home: dirname(dirname(dirname(dir))), id: basename(dir) };
}
/** A shell word as the kernel renders one (lib/core.mjs shq): what a path looks like inside a hook command. */
const shellEscaped = (text) => text.replace(/'/g, `'\\''`);
/** A capability row whose hook commands name the home's copies → the row with them naming the
 *  kernel's copies: the path of the home's modules directory, where a rendered command holds it
 *  (`node '<home>/.oats/modules/<id>/<script>' …`), becomes the store's. */
function repointed(home, row, store, earlier) {
  if (!isPlainObject(row?.hooks)) return row;
  const to = shellEscaped(`${join(homeModulesStore(home), store)}${sep}`);
  // From the home's copies (a row a spawn or an upgrade has just resolved), and from the store an
  // earlier receipt named (a row of a module an upgrade did not move).
  const from = [`${join(home, ".oats", "modules")}${sep}`, ...(earlier ? [`${join(homeModulesStore(home), earlier)}${sep}`] : [])].map(shellEscaped);
  const hooks = Object.fromEntries(Object.entries(row.hooks).map(([event, command]) => [event, typeof command === "string" ? from.reduce((text, prefix) => text.split(prefix).join(to), command) : command]));
  return { ...row, hooks };
}
/** The capability rows a receipt holds, naming the copies in `store`, from the rows a spawn or an
 *  upgrade resolved (`earlier`: the store the home's receipt named until now). */
const storedRows = (home, rows, store, earlier = null) => JSON.parse(JSON.stringify(rows ?? [])).map((row) => repointed(home, row, store, earlier));
/** A new store for a home's kernel copies: its name, and its directory, made. */
function newStore(home) {
  const store = randomBytes(6).toString("hex"), dir = join(homeModulesStore(home), store);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { store, dir };
}
/** Copy a module's tree into a store: links as links, never followed, and nothing overwritten.
 *  A `.git` at the module's root is left out: the digest a module is verified by passes over it
 *  (lib/remote.mjs contentDigest), so what the kernel keeps is exactly what was verified. */
function copyModule(from, to) {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: (source) => source !== join(from, ".git") });
}

/** Take away the kernel's copies of a home's modules, every store of them: a retire's and a
 *  spawn's rollback's last act on them, and a spawn's first (whatever an earlier home of that
 *  path left). */
export function removeModulesStore(home) {
  rmSync(homeModulesStore(home), { recursive: true, force: true });
}
/** Take away every store of a home's kernel copies but the ones its receipt names: the one the
 *  kernel runs from, and the one before it (`composition.previous`), which an undo goes back to.
 *  Called only once a move is COMPLETE (its receipt written, and nothing left that could put the
 *  earlier receipt back): what it removes is what no receipt names any more and none will again
 *  (the store before the previous one, after a move; the newer one, after an undo), and what an
 *  earlier move that was interrupted had made and never named. */
export function pruneModulesStores(home) {
  const composition = providerHomeTrust(home)?.composition;
  if (!composition) return;
  const keep = new Set([composition.store, ...(composition.previous ? [composition.previous.store] : [])]);
  let names;
  try { names = readdirSync(homeModulesStore(home)); } catch { return; }
  for (const name of names) if (!keep.has(name)) rmSync(join(homeModulesStore(home), name), { recursive: true, force: true });
}
/** The composition an upgrade leaves a provider home, with the kernel's copies for it in a NEW
 *  store, beside the one the receipt names now: each module in `moved` copied from
 *  `source(id)` (the copy the upgrade has just found to be the one it verified against the lock:
 *  by default the home's own), every other module copied from the kernel's own current copy;
 *  `modules` (`{ <id>: { from?, commit? } }`) and `rows` are what the upgrade derived. Its
 *  `previous` is the composition the receipt names now (its store, modules and rows), which an
 *  undo goes back to. Nothing the receipt names is touched: the caller's ONE write of the
 *  receipt is what makes the new store and the new rows the home's, together. Throws, with the
 *  new store removed, when a copy cannot be made. */
export function upgradedComposition(home, trust, { moved, modules, rows, source = (id) => homeModuleDir(home, id) }) {
  const { store, dir } = newStore(home);
  try {
    for (const id of Object.keys(modules).sort(byCodeUnit)) copyModule(moved.has(id) ? source(id) : kernelModuleDir(home, id, trust), join(dir, id));
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  const { store: earlier, modules: earlierModules, capabilityRuntime: earlierRows } = trust.composition;
  return { version: COMPOSITION_VERSION, store, modules, capabilityRuntime: storedRows(home, rows, store, earlier).filter((row) => Object.hasOwn(modules, row?.id)),
    previous: { store: earlier, modules: earlierModules, capabilityRuntime: earlierRows } };
}
/** Take away the store `store` of a home's kernel copies, unless the home's receipt names it (as
 *  the one it runs from, or the previous one): what a move that failed had made, and nothing else. */
export function removeUnnamedStore(home, store) {
  const composition = providerHomeTrust(home)?.composition;
  if (!store || composition?.store === store || composition?.previous?.store === store) return;
  rmSync(join(homeModulesStore(home), store), { recursive: true, force: true });
}
/** The composition an undo goes back to: the one the receipt keeps as `previous` (its store, which
 *  is still there, with its modules and rows), with no `previous` of its own; null when the
 *  receipt keeps none. Nothing is copied: the one write of the receipt names that store again. */
export function previousComposition(trust) {
  const previous = trust?.composition?.previous;
  return previous ? { version: COMPOSITION_VERSION, store: previous.store, modules: previous.modules, capabilityRuntime: previous.capabilityRuntime } : null;
}

/** A provider home's composition, as its spawn records it in the receipt, with the kernel's own
 *  copy of every module put in place: `{ version, store, modules: { <id>: { from?, commit? } },
 *  capabilityRuntime: [<row>] }` (an upgrade adds `previous: { store, modules, capabilityRuntime }`,
 *  the one it replaced). The modules are the directories under `<home>/.oats/modules/`
 *  as they are now, and `from` and `commit` (where each came from: what an upgrade moves it
 *  from) are the home's record's as it is now. A spawn calls this ONCE, at its first write of
 *  the receipt, which in every work mode is before its provider is asked to launch, so before
 *  the home's agent exists; every later write of that spawn keeps what this recorded (lib/core.mjs
 *  writeRetirementBaseline). `rows` are the capability rows the spawn resolved. Throws when a
 *  copy cannot be made: a spawn that cannot keep what it made records nothing. */
export function compositionOf(home, rows) {
  const root = join(home, ".oats", "modules");
  const recorded = readJsonOrUndefined(join(home, "instance.json"))?.modules;
  const modules = {};
  let names;
  try { names = readdirSync(root).sort(byCodeUnit); } catch (e) { if (e?.code !== "ENOENT") throw e; names = []; }
  removeModulesStore(home);
  const { store, dir } = newStore(home);
  for (const id of names) {
    if (!lstatSync(join(root, id)).isDirectory()) continue;
    copyModule(join(root, id), join(dir, id));
    const source = isPlainObject(recorded) && Object.hasOwn(recorded, id) && isPlainObject(recorded[id]) ? recorded[id] : null;
    modules[id] = { ...(isPlainObject(source?.from) ? { from: JSON.parse(JSON.stringify(source.from)) } : {}), ...(typeof source?.commit === "string" ? { commit: source.commit } : {}) };
  }
  return { version: COMPOSITION_VERSION, store, modules, capabilityRuntime: storedRows(home, rows, store) };
}

const validPair = (c) => isPlainObject(c) && typeof c.store === "string" && STORE_RE.test(c.store) && isPlainObject(c.modules) && Array.isArray(c.capabilityRuntime)
  && Object.values(c.modules).every((m) => isPlainObject(m))
  && c.capabilityRuntime.every((row) => isPlainObject(row) && typeof row.id === "string");
function validComposition(c) {
  return isPlainObject(c) && c.version === COMPOSITION_VERSION && validPair(c) && (c.previous === undefined || (validPair(c.previous) && c.previous.store !== c.store));
}

/** What a home's receipt says the kernel runs of it:
 *  - null: the receipt names no session provider (a tmux home), or there is none for this home:
 *    the home is read and run as it always was;
 *  - `{ composition }`: a provider home, with what its spawn recorded;
 *  - `{ problem }` (one sentence): a provider home whose receipt holds no composition this kernel
 *    reads. A kernel from before this rule spawned it; nothing of it is run.
 *  The receipt is read each time: it is the record, and an upgrade may have rewritten it. */
export function providerHomeTrust(home) {
  const baseline = homeReceipt(home);
  return baseline ? receiptTrust(baseline, home) : null;
}
/** providerHomeTrust, of a receipt its caller has read and found to be this home's. */
export function receiptTrust(baseline, home) {
  if (!isPlainObject(baseline?.runtime) || typeof baseline.runtime.provider !== "string") return null;
  if (validComposition(baseline.composition)) return { composition: baseline.composition };
  return { problem: `${basename(home)} is on a session provider and its receipt records nothing of what it was spawned with (a kernel from before the receipt recorded it spawned the home, or the receipt was rewritten): none of its capabilities is run. Retire it and spawn it again` };
}

/** Why the kernel runs nothing of capability `id` in a provider home → one sentence that names
 *  the module, or null when it may: the receipt records the module and the kernel holds its copy
 *  of it. Null for a home that is no provider home (`trust` null: providerHomeTrust's answer,
 *  read here when it is not given). */
export function moduleCopyProblem(home, id, trust = providerHomeTrust(home)) {
  if (!trust) return null;
  if (trust.problem) return trust.problem;
  if (!Object.hasOwn(trust.composition.modules, id)) return `capability ${id} is not one ${basename(home)} was spawned with (its receipt records no such module): nothing of it is run`;
  const dir = kernelModuleDir(home, id, trust);
  let kept = false;
  try { kept = lstatSync(dir).isDirectory(); } catch { /* not there */ }
  return kept ? null : `the kernel's copy of capability ${id} for ${basename(home)} is not at ${dir}: nothing of the capability is run. Retire the instance and spawn it again`;
}
/** Why the kernel launches nothing in a provider home → the first module's problem
 *  (moduleCopyProblem), or null. */
export function homeModulesProblem(home, trust = providerHomeTrust(home)) {
  if (!trust) return null;
  if (trust.problem) return trust.problem;
  for (const id of Object.keys(trust.composition.modules).sort(byCodeUnit)) {
    const problem = moduleCopyProblem(home, id, trust);
    if (problem) return problem;
  }
  return null;
}
/** The directory the kernel runs capability `id` of `home` from: its own copy for a provider
 *  home, the home's for any other. */
export function runDirOf(home, id, trust = providerHomeTrust(home)) {
  return trust ? kernelModuleDir(home, id, trust) : homeModuleDir(home, id);
}
/** For a caller that holds a directory it is about to run a file of: why it may not → a
 *  sentence, when `dir` is a provider home's OWN copy (`<home>/.oats/modules/<id>`), which the
 *  kernel never runs; null for any other directory (the kernel's copy, a tmux home's copy, a
 *  deployment's module store). A guard: every caller is given the kernel's copy to begin with. */
export function moduleCopyProblemAt(dir) {
  const at = homeOfModuleCopy(dir);
  if (!at || !providerHomeTrust(at.home)) return null;
  return `${dir} is ${basename(at.home)}'s own copy of capability ${at.id}, and ${basename(at.home)} is on a session provider: the kernel runs its own copy of it (${kernelModuleDir(at.home, at.id)}), never the home's`;
}
/** What a provider home's row says of its modules' copies → `{ runs: "kernel-copy", homeCopy:
 *  "same" | "differs", differs: [<module id>] }`, or undefined for a home that is no provider home
 *  or whose receipt holds no composition. `runs`: which copy the kernel runs. `homeCopy` compares
 *  RECORDS only, with nothing hashed and no file of a copy read: the home's own record of each
 *  module (instance.json `modules.<id>`: its `from` and `commit`) against the receipt's. They
 *  differ after an upgrade that was interrupted between moving the home's copies and writing the
 *  receipt, and whenever the home's record was rewritten; `differs` names the modules, those
 *  only one of the two names included (capability ids only, at most 200: a name the home's
 *  record gives that is none is counted in `homeCopy` and not named). Whether a home copy's FILES are the kernel's is
 *  `oats readiness --home`'s `kernelCopies`. */
export function moduleCopyReport(meta, trust) {
  if (!trust?.composition) return undefined;
  const recorded = trust.composition.modules, own = isPlainObject(meta?.modules) ? meta.modules : {};
  const same = (id) => Object.hasOwn(recorded, id) && Object.hasOwn(own, id) && isPlainObject(own[id])
    && JSON.stringify(sorted(own[id].from ?? null)) === JSON.stringify(sorted(recorded[id].from ?? null)) && (own[id].commit ?? null) === (recorded[id].commit ?? null);
  const differing = [...new Set([...Object.keys(recorded), ...Object.keys(own)])].filter((id) => !same(id));
  // The names are the home's own to choose (the keys of its record): only capability ids are
  // named, and no more than a row may carry; `homeCopy` says "differs" whatever is named.
  const differs = differing.filter((id) => MODULE_ID_RE.test(id) && id.length <= MODULE_COPY_ID_MAX).sort(byCodeUnit).slice(0, MODULE_COPY_IDS_MAX);
  return { runs: "kernel-copy", homeCopy: differing.length ? "differs" : "same", differs };
}
/** A row's `moduleCopy` as another kernel reported it (a remote roster's row), read by this
 *  kernel's own rule → the value, or undefined when it is not one: exactly the three keys,
 *  `runs: "kernel-copy"`, `homeCopy` one of the two words, `differs` a list of at most 200
 *  capability ids, empty when `homeCopy` is `same`. */
export function readModuleCopy(value) {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "differs,homeCopy,runs" || value.runs !== "kernel-copy") return undefined;
  if (!Array.isArray(value.differs) || value.differs.length > MODULE_COPY_IDS_MAX || !value.differs.every((id) => typeof id === "string" && id.length <= MODULE_COPY_ID_MAX && MODULE_ID_RE.test(id))) return undefined;
  if (value.homeCopy !== "same" && value.homeCopy !== "differs") return undefined;
  if (value.homeCopy === "same" && value.differs.length) return undefined;
  return { runs: "kernel-copy", homeCopy: value.homeCopy, differs: [...value.differs] };
}
/** A JSON value with every object's keys in one order, for a comparison by text. */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(byCodeUnit).map((key) => [key, sorted(value[key])]));
}
/** Whether a provider home's receipt records a module `id`: true for a home that is no provider
 *  home (every module of its record counts, as before). */
export function recordsModule(trust, id) {
  return !trust || (!!trust.composition && Object.hasOwn(trust.composition.modules, id));
}
/** The fields of a capability row that the receipt decides, for a hook or a command of a provider
 *  home: whatever a caller's row says of them is replaced (trustedCapability). */
const ROW_FIELDS = ["layer", "level", "settings", "settingsOrigins", "hooks", "requiredHooks", "environment", "environmentNamespaces", "missingRequires", "trust", "executable"];
/** A capability row as the kernel may use it in a provider home → `{ cap }`: the caller's row
 *  with every field the receipt decides replaced by the receipt's (an absent one made absent), or
 *  `{ cap, problem }` when the receipt records no such capability: nothing of it is run. For a
 *  home that is no provider home, `{ cap }` as given. */
export function trustedCapability(home, cap, trust) {
  if (!trust) return { cap };
  const row = trustedRow(trust, cap.id);
  if (!row) return { cap, problem: trust.problem ?? `capability ${cap.id} is not one ${basename(home)} was spawned with (its receipt records no row for it): nothing of it is run` };
  return { cap: { ...cap, ...Object.fromEntries(ROW_FIELDS.map((k) => [k, row[k]])) } };
}
/** A home's record as the kernel may use it: for a provider home its `capabilityRuntime` is the
 *  receipt's, and so is `providers` (each capability's settings, which is where an upgrade reads
 *  them), whatever instance.json says; both absent when the receipt holds no composition (the
 *  home then records no hooks this kernel can identify). Any other home's record as given. */
export function trustedRecord(meta, trust) {
  if (!trust || !isPlainObject(meta)) return meta;
  const { capabilityRuntime: _rows, providers: _settings, ...rest } = meta;
  if (!trust.composition) return rest;
  const rows = trust.composition.capabilityRuntime;
  return { ...rest, capabilityRuntime: rows, providers: Object.fromEntries(rows.map((row) => [row.id, isPlainObject(row.settings) ? row.settings : {}])) };
}
/** A provider home's record with what an upgrade reads of each module: the module set is the
 *  receipt's (a module the record adds or leaves out is refused: `{ problem }`), and each
 *  module's `from` and `commit` are the receipt's where it records them. `{ meta }` otherwise;
 *  `{ meta }` as given for a home that is no provider home. */
export function trustedModuleRecords(home, meta, trust) {
  if (!trust?.composition || !isPlainObject(meta?.modules)) return { meta };
  const recorded = trust.composition.modules;
  const added = Object.keys(meta.modules).filter((id) => !Object.hasOwn(recorded, id)).sort(byCodeUnit);
  const dropped = Object.keys(recorded).filter((id) => !Object.hasOwn(meta.modules, id)).sort(byCodeUnit);
  if (added.length || dropped.length) return { problem: `the modules ${basename(home)}'s own record names are not the ones its receipt records (${[added.length ? `the record adds ${added.join(", ")}` : "", dropped.length ? `the record leaves out ${dropped.join(", ")}` : ""].filter(Boolean).join("; ")}). Retire the instance and spawn it again` };
  const modules = Object.fromEntries(Object.entries(meta.modules).map(([id, row]) => [id, { ...row, ...(recorded[id].from ? { from: recorded[id].from } : {}), ...(recorded[id].commit ? { commit: recorded[id].commit } : {}) }]));
  return { meta: { ...meta, modules } };
}
/** The capability row the kernel uses for `id` in a provider home: the receipt's, or undefined
 *  when it records none. */
export function trustedRow(trust, id) {
  return trust?.composition?.capabilityRuntime.find((row) => row.id === id);
}
/** A home's capability rows as the kernel may use them: the receipt's for a provider home (none
 *  when its receipt holds no composition), else the rows of the home's own record. */
export function capabilityRuntimeOf(home, meta, trust = providerHomeTrust(home)) {
  if (!trust) return Array.isArray(meta?.capabilityRuntime) ? meta.capabilityRuntime : [];
  return trust.composition ? trust.composition.capabilityRuntime : [];
}
