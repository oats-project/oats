/** A home's drift: how each recorded module and the recorded soul compare with what the workspace offers
 *  now. A leaf (awebai/oats#1630): `oats status` reports drift without loading the home composer
 *  (materialize.mjs), which imports these helpers and re-exports what it exported. */
import { memberRowByKey } from "./workspace.mjs";

const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * driftOf(instanceJson, discovery, { lock } = {})
 * → [{ module, from, recorded: { repoKey, commit }, current: { commit } | null, status: "current"|"moved"|"missing", reason? }]
 *
 * Member modules: the confirmed member row for `repoKey` in `discovery.members` is the current
 * state — unconfirmed/absent → "missing" (reason "unconfirmed"); the capability gone from the
 * member → "missing" (reason "capability-absent"); a different commit → "moved"; else "current".
 * Package modules are pinned by version: without a lock they are "current"; with one, the lock's
 * entry decides — absent package or capability → "missing", another commit → "moved".
 */
export function driftOf(instanceJson, discovery, { lock } = {}) {
  const modules = plainObject(instanceJson?.modules) ? instanceJson.modules : {};
  const members = Array.isArray(discovery?.members) ? discovery.members : [];
  const rows = [];
  for (const name of Object.keys(modules).sort()) {
    const rec = modules[name] || {};
    const from = plainObject(rec.from) ? rec.from : {};
    const commit = typeof rec.commit === "string" ? rec.commit : (typeof from.commit === "string" ? from.commit : null);
    if (from.kind === "package") {
      const recorded = { repoKey: from.repoKey ?? null, package: from.package ?? null, version: from.version ?? null, commit };
      if (!plainObject(lock?.packages)) { rows.push({ module: name, from: clone(from), recorded, current: commit ? { commit } : null, status: "current" }); continue; }
      const entry = lock.packages[from.package];
      if (!entry) { rows.push({ module: name, from: clone(from), recorded, current: null, status: "missing", reason: "package-absent" }); continue; }
      if (Array.isArray(entry.capabilities) && !entry.capabilities.includes(name)) {
        rows.push({ module: name, from: clone(from), recorded, current: { commit: entry.commit, version: entry.version }, status: "missing", reason: "capability-absent" }); continue;
      }
      rows.push({ module: name, from: clone(from), recorded, current: { commit: entry.commit, version: entry.version }, status: entry.commit === commit ? "current" : "moved" });
      continue;
    }
    const repoKey = typeof from.repoKey === "string" ? from.repoKey : null;
    const recorded = { repoKey, commit };
    const member = repoKey ? memberRowByKey(members, repoKey) : null;
    if (!member || !member.confirmed || typeof member.commit !== "string") {
      rows.push({ module: name, from: clone(from), recorded, current: null, status: "missing", reason: member ? (member.reason || "unconfirmed") : "unconfirmed" });
      continue;
    }
    const cap = Array.isArray(member.capabilities) ? member.capabilities.find((c) => c && c.name === name) : null;
    if (!cap) { rows.push({ module: name, from: clone(from), recorded, current: { commit: member.commit }, status: "missing", reason: "capability-absent" }); continue; }
    // `version` (feature desktop-facts): the member capability's manifest version now, beside the commit.
    rows.push({ module: name, from: clone(from), recorded, current: { commit: member.commit, version: typeof cap.manifest?.version === "string" ? cap.manifest.version : null }, status: member.commit === commit ? "current" : "moved" });
  }
  return rows;
}

/**
 * soulDriftOf(instanceJson, discovery)
 * → { name, repoKey, commit, current: { commit } | null, status: "current"|"moved"|"missing", reason? } | null
 *
 * Decision 17 for the SOUL SOURCE: a workspace spawn records `instance.json.workspace.soul =
 * { repoKey, commit }` (the member and commit the soul was fetched from). The member row
 * for `repoKey` in `discovery.members` is the current state: a different commit → "moved", the
 * soul gone from the member → "missing" (reason "soul-absent"), no usable row → "missing"
 * (reason "unconfirmed" / the row's reason). A standalone view's own member row is unconfirmed
 * by construction (reason "cannot-read") yet carries the repo's current commit — it is compared,
 * not reported missing. Returns null for a home without a recorded workspace soul (classic).
 * A PACKAGE soul (`workspace.soul.package`) is compared with the discovery's package souls: the
 * pin moved → "moved"; the package no longer locked/declared → "missing" ("package-absent"); the
 * soul no longer shipped by the package → "missing" ("soul-absent").
 */
export function soulDriftOf(instanceJson, discovery) {
  const soul = plainObject(instanceJson?.workspace) && plainObject(instanceJson.workspace.soul) ? instanceJson.workspace.soul : null;
  if (!soul || typeof soul.repoKey !== "string") return null;
  const name = typeof instanceJson.agent === "string" ? instanceJson.agent : (typeof instanceJson.soul === "string" ? instanceJson.soul : null);
  const commit = typeof soul.commit === "string" ? soul.commit : null;
  if (plainObject(soul.package) && typeof soul.package.id === "string") {
    // A package soul: "moved" means the package pin moved (another version/commit is locked now).
    const pkg = { package: soul.package.id, version: soul.package.version ?? null };
    const soulName = typeof soul.name === "string" ? soul.name : name;
    const base = { name: soulName, repoKey: soul.repoKey, commit, ...pkg };
    const listed = Array.isArray(discovery?.packageSouls) ? discovery.packageSouls.filter((s) => s && s.package === soul.package.id) : [];
    const now = listed.find((s) => s.name === soulName) || null;
    if (!now) return { ...base, current: null, status: "missing", reason: listed.length ? "soul-absent" : "package-absent" };
    return { ...base, current: { commit: now.commit, version: now.version }, status: now.commit === commit ? "current" : "moved" };
  }
  const members = Array.isArray(discovery?.members) ? discovery.members : [];
  const member = memberRowByKey(members, soul.repoKey);
  const standaloneOwn = discovery?.standalone === true && member && member.key === discovery.key && typeof member.commit === "string";
  const base = { name, repoKey: soul.repoKey, commit };
  if (!member || (!member.confirmed && !standaloneOwn) || typeof member.commit !== "string") {
    return { ...base, current: null, status: "missing", reason: member ? (member.reason || "unconfirmed") : "unconfirmed" };
  }
  const present = name === null || (Array.isArray(member.souls) && member.souls.some((s) => s && s.name === name));
  if (!present) return { ...base, current: { commit: member.commit }, status: "missing", reason: "soul-absent" };
  return { ...base, current: { commit: member.commit }, status: member.commit === commit ? "current" : "moved" };
}

export { clone, plainObject };
