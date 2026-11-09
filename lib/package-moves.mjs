/** The official packages that were renamed: the old and the new id of each are one package (docs/workspaces.md
 *  "Renamed packages"), the way lib/repo-moves.mjs makes two keys one repository. A leaf: no I/O, no imports.
 *
 *  It compares and never rewrites. An id stays as it was declared or recorded, in every answer, path and lock:
 *  instance.json, oats-local.yaml, oats-workspace.yaml, schedules and triggers keep the old id, and a home's
 *  OATS_SOUL_ID stays `package:<old id>#<soul>`. Readers compare through samePackage, or resolve a selector or a
 *  key through currentPackageId. */

/** old id → new id. Kept for good: old oats-local.yaml, workspaces, homes and automations name them. */
const RENAMED = Object.assign(Object.create(null), {
  "oats.engineering": "oats.engineering-coordination",
});

/** The id a package has now: the new id of a renamed one, any other value as it came. */
export const currentPackageId = (id) => RENAMED[id] ?? id;
/** Whether two ids name one package: they are the same, or one is the other's rename. */
export const samePackage = (a, b) => a === b || currentPackageId(a) === currentPackageId(b);
