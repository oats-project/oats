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
 *    made by the spawn from the copies it materialised, before the provider is asked to launch.
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
  return join(homeModulesStore(home), trust?.composition?.store ?? "-", id);
}
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
/** Copy a module's tree into a store: links as links, never followed, and nothing overwritten. */
const copyModule = (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });

/** Take away the kernel's copies of a home's modules, every store of them: a retire's and a
 *  spawn's rollback's last act on them, and a spawn's first (whatever an earlier home of that
 *  path left). */
export function removeModulesStore(home) {
  rmSync(homeModulesStore(home), { recursive: true, force: true });
}
/** Take away every store of a home's kernel copies but the one its receipt names: what an
 *  upgrade leaves once its receipt is written, and what one that was interrupted left. */
export function pruneModulesStores(home) {
  const keep = providerHomeTrust(home)?.composition?.store;
  let names;
  try { names = readdirSync(homeModulesStore(home)); } catch { return; }
  for (const name of names) if (name !== keep) rmSync(join(homeModulesStore(home), name), { recursive: true, force: true });
}
/** The composition an upgrade leaves a provider home, with the kernel's copies for it in a NEW
 *  store, beside the one the receipt names now: each module in `moved` copied from the home's
 *  copy (which the upgrade has just found to be the one it verified against the lock), every
 *  other module copied from the kernel's own earlier copy; `modules` (`{ <id>: { from?, commit? } }`)
 *  and `rows` are what the upgrade derived. Nothing the receipt names is touched: the caller's
 *  one write of the receipt is what makes the new store and the new rows the home's, together,
 *  and pruneModulesStores then takes the old one away. Throws, with the new store removed, when a
 *  copy cannot be made. */
export function upgradedComposition(home, trust, { moved, modules, rows }) {
  const { store, dir } = newStore(home);
  try {
    for (const id of Object.keys(modules).sort(byCodeUnit)) copyModule(moved.has(id) ? homeModuleDir(home, id) : kernelModuleDir(home, id, trust), join(dir, id));
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return { version: COMPOSITION_VERSION, store, modules, capabilityRuntime: storedRows(home, rows, store, trust.composition.store).filter((row) => Object.hasOwn(modules, row?.id)) };
}

/** A provider home's composition, as its spawn records it in the receipt, with the kernel's own
 *  copy of every module put in place: `{ version, store, modules: { <id>: { from?, commit? } },
 *  capabilityRuntime: [<row>] }`. The modules are the directories under `<home>/.oats/modules/`
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
  // (Rows that name a store this home's receipt named before, which goes now: a test's stand-in for an upgrade.)
  const earlier = providerHomeTrust(home)?.composition?.store ?? null;
  removeModulesStore(home);
  const { store, dir } = newStore(home);
  for (const id of names) {
    if (!lstatSync(join(root, id)).isDirectory()) continue;
    copyModule(join(root, id), join(dir, id));
    const source = isPlainObject(recorded) && Object.hasOwn(recorded, id) && isPlainObject(recorded[id]) ? recorded[id] : null;
    modules[id] = { ...(isPlainObject(source?.from) ? { from: JSON.parse(JSON.stringify(source.from)) } : {}), ...(typeof source?.commit === "string" ? { commit: source.commit } : {}) };
  }
  return { version: COMPOSITION_VERSION, store, modules, capabilityRuntime: storedRows(home, rows, store, earlier) };
}
/** The composition a provider home's receipt already holds, or null: what a later write of the
 *  receipt keeps, so that nothing is taken again from a home its agent has run in. */
export function recordedComposition(home) {
  const trust = providerHomeTrust(home);
  return trust?.composition ?? null;
}

function validComposition(c) {
  return isPlainObject(c) && c.version === COMPOSITION_VERSION && typeof c.store === "string" && STORE_RE.test(c.store) && isPlainObject(c.modules) && Array.isArray(c.capabilityRuntime)
    && Object.values(c.modules).every((m) => isPlainObject(m))
    && c.capabilityRuntime.every((row) => isPlainObject(row) && typeof row.id === "string");
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
 *  receipt's (absent when the receipt holds no composition: the home then records no hooks this
 *  kernel can identify), whatever instance.json says; any other home's record as given. */
export function trustedRecord(meta, trust) {
  if (!trust || !isPlainObject(meta)) return meta;
  const { capabilityRuntime: _fromTheHome, ...rest } = meta;
  return trust.composition ? { ...rest, capabilityRuntime: trust.composition.capabilityRuntime } : rest;
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
