/** What the kernel trusts of a provider home (docs/capabilities.md "What the kernel trusts in a
 *  provider home"; the contract's D16 rule 3).
 *
 *  A home on a session provider can be written by its own agent: the provider may run the harness
 *  in a sandbox that still writes the home, and the kernel that runs the home's hooks and its
 *  provider's commands runs outside any sandbox, as the operator. So for such a home nothing the
 *  kernel RUNS, and no capability setting it hands to what it runs, is taken from the home alone:
 *
 *  - the home's receipt (outside the home, lib/session-receipt.mjs) carries its `composition`: the
 *    digest of every module copy as the spawn made it, and the capability rows the spawn resolved
 *    from the deployment (settings, their origins, the hook commands, levels). `oats instance
 *    upgrade` rewrites it in the step that moves the copies;
 *  - a module copy is run only when it digests to what the receipt records (moduleCopyProblem),
 *    hashed whole each time, with no cache: a time stamp can be set back;
 *  - a capability's row is the receipt's, never instance.json's `capabilityRuntime` (trustedRows).
 *
 *  A tmux home is unchanged, and why: its agent already runs unsandboxed as the operator, and can
 *  do directly whatever a module it rewrote could. This protects nothing against an agent that can
 *  write the receipt itself; a provider that sandboxes keeps `<instances>/.oats-retirement/`
 *  unwritable.
 *
 *  A leaf: it reads files and hashes them, and knows nothing of sessions or of core.mjs. */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homeReceipt, isPlainObject, readJsonOrUndefined } from "./session-receipt.mjs";

/** The version of a receipt's `composition`, which says how its digests are taken (moduleCopyDigest). */
export const COMPOSITION_VERSION = 1;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const PIECE = 1024 * 1024;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Where a home keeps its copy of capability `id`. */
export const moduleCopyDir = (home, id) => join(home, ".oats", "modules", id);
/** The home a module copy belongs to, when `dir` is `<home>/.oats/modules/<id>`: `{ home, id }`,
 *  else null (a deployment's own module store, a soul's tree). */
export function homeOfModuleCopy(dir) {
  if (typeof dir !== "string" || basename(dirname(dir)) !== "modules" || basename(dirname(dirname(dir))) !== ".oats") return null;
  return { home: dirname(dirname(dirname(dir))), id: basename(dir) };
}

/** The digest of a module copy, whole → `{ digest: "sha256:<hex>", bytes, entries }`, or
 *  `{ over: "<what>" }` when it holds more than `limit` allows, or `{ unread: "<why>" }` when a
 *  part of it cannot be read. Never throws.
 *
 *  Every entry under `dir` counts, by its path from `dir`, in the order of the names' code units:
 *  a directory (its name), a regular file (whether it is executable, its length, its bytes), a
 *  symbolic link (its target as text, never followed), and anything else by its kind alone. No
 *  name is passed over: a file added beside the ones the spawn copied changes the digest.
 *
 *  `limit` (`{ bytes, entries }`: what the receipt records the copy holds) bounds the read: a
 *  copy that has grown is told so as soon as it exceeds them, so a file of any size put in a home
 *  costs a read of no more than the copy's own size. Files are read by descriptor, opened without
 *  following a link and without waiting on a FIFO, in pieces. */
export function moduleCopyDigest(dir, limit = null) {
  const hash = createHash("sha256");
  let bytes = 0, entries = 0;
  const field = (text) => { const b = Buffer.from(text, "utf8"); hash.update(`${b.length}\0`); hash.update(b); };
  const piece = Buffer.allocUnsafe(PIECE);
  const over = (what) => Object.assign(new Error(what), { over: what });
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort(byCodeUnit)) {
      const path = join(abs, name), at = rel ? `${rel}/${name}` : name;
      if (++entries > (limit?.entries ?? Infinity)) throw over(`more than the ${limit.entries} entries the spawn copied`);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { hash.update("d"); field(at); walk(path, at); continue; }
      if (stat.isSymbolicLink()) { hash.update("l"); field(at); field(readlinkSync(path)); continue; }
      if (!stat.isFile()) { hash.update("o"); field(at); continue; }
      const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
      try {
        const open = fstatSync(fd);
        if (!open.isFile()) { hash.update("o"); field(at); continue; }
        hash.update(open.mode & 0o111 ? "x" : "f"); field(at);
        let read = 0;
        for (;;) {
          const n = readSync(fd, piece, 0, PIECE, null);
          if (n === 0) break;
          read += n; bytes += n;
          if (bytes > (limit?.bytes ?? Infinity)) throw over(`more than the ${limit.bytes} bytes the spawn copied`);
          hash.update(piece.subarray(0, n));
        }
        // The length after the bytes: it is what was read, so a file that grew while it was read
        // digests as the bytes this read saw.
        hash.update(`\0${read}\0`);
      } finally { closeSync(fd); }
    }
  };
  try {
    if (!lstatSync(dir).isDirectory()) return { unread: "it is not a directory" };
    walk(dir, "");
  } catch (e) {
    if (e?.over) return { over: e.over };
    return { unread: e?.code === "ENOENT" ? "it is missing, or a part of it went missing while it was read" : String(e?.code ?? e?.message ?? e) };
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes, entries };
}

/** A provider home's composition, as its spawn (or an upgrade) records it in the receipt:
 *  `{ version, modules: { <id>: { digest, bytes, entries, from?, commit? } }, capabilityRuntime: [<row>] }`.
 *  The module copies are hashed as they are in `home` now, and `from` and `commit` (where each
 *  module came from: what an upgrade moves it from) are read from the home's record as it is
 *  now. A spawn calls this ONCE, at its first write of the receipt, which in every work mode is
 *  before its provider is asked to launch, so before the home's agent exists; every later write
 *  of that spawn keeps what this recorded (lib/core.mjs writeRetirementBaseline). `rows` are the
 *  capability rows the spawn resolved, as the home's record holds them. Throws when a copy
 *  cannot be digested: a spawn that cannot record what it made records nothing. */
export function compositionOf(home, rows) {
  const root = join(home, ".oats", "modules");
  const recorded = readJsonOrUndefined(join(home, "instance.json"))?.modules;
  const modules = {};
  let names;
  try { names = readdirSync(root).sort(byCodeUnit); } catch (e) { if (e?.code !== "ENOENT") throw e; names = []; }
  for (const id of names) {
    const d = moduleCopyDigest(join(root, id));
    if (!d.digest) throw new Error(`cannot digest the module copy ${join(root, id)}: ${d.unread ?? d.over}`);
    const source = isPlainObject(recorded) && Object.hasOwn(recorded, id) && isPlainObject(recorded[id]) ? recorded[id] : null;
    modules[id] = { ...d, ...(isPlainObject(source?.from) ? { from: JSON.parse(JSON.stringify(source.from)) } : {}), ...(typeof source?.commit === "string" ? { commit: source.commit } : {}) };
  }
  return { version: COMPOSITION_VERSION, modules, capabilityRuntime: JSON.parse(JSON.stringify(rows ?? [])) };
}
/** The composition a provider home's receipt already holds, or null: what a later write of the
 *  receipt keeps, so that the copies are never recorded again from a home its agent has run in. */
export function recordedComposition(home) {
  const trust = providerHomeTrust(home);
  return trust?.composition ?? null;
}
/** A provider home's record with what an upgrade reads of each module besides its copy: the
 *  module set is the receipt's (a module the record adds or leaves out is refused: `{ problem }`),
 *  and each module's `from` and `commit` are the receipt's where it records them. `{ meta }`
 *  otherwise; `{ meta }` as given for a home that is no provider home. */
export function trustedModuleRecords(home, meta, trust) {
  if (!trust?.composition || !isPlainObject(meta?.modules)) return { meta };
  const recorded = trust.composition.modules;
  const added = Object.keys(meta.modules).filter((id) => !Object.hasOwn(recorded, id)).sort(byCodeUnit);
  const dropped = Object.keys(recorded).filter((id) => !Object.hasOwn(meta.modules, id)).sort(byCodeUnit);
  if (added.length || dropped.length) return { problem: `the modules ${basename(home)}'s own record names are not the ones its receipt records (${[added.length ? `the record adds ${added.join(", ")}` : "", dropped.length ? `the record leaves out ${dropped.join(", ")}` : ""].filter(Boolean).join("; ")}). Retire the instance and spawn it again` };
  const modules = Object.fromEntries(Object.entries(meta.modules).map(([id, row]) => [id, { ...row, ...(recorded[id].from ? { from: recorded[id].from } : {}), ...(recorded[id].commit ? { commit: recorded[id].commit } : {}) }]));
  return { meta: { ...meta, modules } };
}

function validComposition(c) {
  return isPlainObject(c) && c.version === COMPOSITION_VERSION && isPlainObject(c.modules) && Array.isArray(c.capabilityRuntime)
    && Object.values(c.modules).every((m) => isPlainObject(m) && typeof m.digest === "string" && DIGEST_RE.test(m.digest) && Number.isSafeInteger(m.bytes) && m.bytes >= 0 && Number.isSafeInteger(m.entries) && m.entries >= 0)
    && c.capabilityRuntime.every((row) => isPlainObject(row) && typeof row.id === "string");
}

/** What a home's receipt says the kernel may trust of it:
 *  - null: the receipt names no session provider (a tmux home), or there is none for this home:
 *    the home is read as it always was;
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

/** Why the kernel does not run capability `id`'s copy in a provider home → one sentence that
 *  names the module, or null when it may: the copy digests to what the receipt records. Null for
 *  a home that is no provider home (`trust` null: providerHomeTrust's answer, read here when it is
 *  not given). The copy is hashed whole at every call. */
export function moduleCopyProblem(home, id, trust = providerHomeTrust(home)) {
  if (!trust) return null;
  if (trust.problem) return trust.problem;
  const dir = moduleCopyDir(home, id);
  const recorded = Object.hasOwn(trust.composition.modules, id) ? trust.composition.modules[id] : null;
  if (!recorded) return `capability ${id} is not one ${basename(home)} was spawned with (its receipt records no copy of it at ${dir}): it is not run`;
  const now = moduleCopyDigest(dir, recorded);
  if (now.digest === recorded.digest) return null;
  const how = now.over ? `holds ${now.over}` : now.unread ? `cannot be read (${now.unread})` : `digests ${now.digest}, and the receipt records ${recorded.digest}`;
  return `the copy of capability ${id} in ${basename(home)} (${dir}) is not the one the home was spawned with: it ${how}. Nothing of it is run. Retire the instance and spawn it again (an upgrade moves a copy only from one the receipt records)`;
}

/** Why the kernel launches nothing in a provider home → the first module copy's problem
 *  (moduleCopyProblem), or null: every copy the receipt records is as the spawn made it. A launch
 *  reads the manifests of all of them (what each requires, declares and contributes), so all of
 *  them are checked before one, whether or not a hook of theirs runs. */
export function homeModulesProblem(home, trust = providerHomeTrust(home)) {
  if (!trust) return null;
  if (trust.problem) return trust.problem;
  for (const id of Object.keys(trust.composition.modules).sort(byCodeUnit)) {
    const problem = moduleCopyProblem(home, id, trust);
    if (problem) return problem;
  }
  return null;
}
/** Whether a provider home's receipt records a copy of capability `id`: true for a home that is
 *  no provider home (every module of its record counts, as before). */
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
/** moduleCopyProblem, for a caller that holds only the directory it is about to run a file of:
 *  null when `dir` is no home's module copy (a deployment's module store, a soul's tree). */
export function moduleCopyProblemAt(dir) {
  const at = homeOfModuleCopy(dir);
  return at ? moduleCopyProblem(at.home, at.id) : null;
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
