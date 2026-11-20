/** Who made a capability, as both clients say it on a capability row (the Desktop UI rework, D24): "official"
 * (a small ✓ whose words say which fact made it official: "Official: in the OATS catalog" or "Official: from the
 * OATS repository") or "by <source>". The words say only what the rule shows: "verified" or "published by OATS" is a
 * trust claim a client rule can't make (dec-feb06c322c75, "listed is not trusted"); a kernel fact for "official" is
 * oats-project/oats#1981. Decided from facts the kernel
 * already reports, never from a name (an `oats.` prefix proves nothing) and never from a new field:
 *
 *  - a **package** capability is official when `oats workspace status` reports its package pinned from the
 *    catalog (`packages[].source` is `catalog:<id>`): only the reviewed official catalog makes a package
 *    pinnable by id (docs/packages.md, docs/official-catalog.md). Caveat: `OATS_PACKAGE_CATALOG` can point a kernel
 *    at another catalog file, and status does not say which one was read. An operator who points it elsewhere gets the
 *    ✓ for that catalog's packages: their choice (the effort's lead, 2026-11-19).
 *    A package pinned by `git:<repo>@<ref>` is "by <repo>", whatever its id;
 *  - a **member** capability is official when its repository is the OATS repository itself
 *    (github.com/oats-project/oats, or its old key github.com/awebai/oats: repo-moves.mjs);
 *  - anything else (another member, an external source, a package status does not list) is "by <source>".
 *
 * Pure and DOM-free; the words are ORIGIN_COPY so no client writes its own. */
import { sameRepo } from './repo-moves.mjs';
import { capabilitySource, memberNames } from './capability-rows.mjs';

/** The OATS repository's key (its moved spelling is the same repository: sameRepo). */
export const OATS_REPO_KEY = 'github.com/oats-project/oats';

export const ORIGIN_COPY = Object.freeze({
  official: 'OATS',
  // The mark's words per the fact that made it official (`reason`): its tooltip and its accessible name.
  officialTitle: Object.freeze({ catalog: 'Official: in the OATS catalog', 'oats-repo': 'Official: from the OATS repository' }),
  by: source => `by ${source}`,
});

const text = v => typeof v === 'string' && v ? v : null;
const list = v => Array.isArray(v) ? v : [];
/** `git:<repo>@<ref>` → the repository's last path segment, without `.git`; null for anything else. */
function gitRepoName(source) {
  const m = /^git:(.+)@[^@]*$/.exec(source || '');
  if (!m) return null;
  return m[1].replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || null;
}

/** `{ official, by, reason }` for a catalog row (`oats capabilities`, or a soul's resolved capability in the same
 * shape). `by` is the source as words ("OATS" when official); `reason` is the fact that decided it: 'catalog'
 * (a package pinned from the catalog), 'oats-repo' (a member capability of the OATS repository), else null.
 * `status`: workspace status (packages[] and members[]); `names`: memberNames(status) when the caller holds it. */
export function capabilityOrigin(row, status, names = memberNames(status)) {
  if (row?.kind === 'package') {
    const pkg = list(status?.packages).find(p => p?.id === row.package);
    const source = text(pkg?.source);
    if (source && source.startsWith('catalog:')) return { official: true, by: ORIGIN_COPY.official, reason: 'catalog' };
    return { official: false, by: gitRepoName(source) || text(row.package) || text(row.name) || 'a package', reason: null };
  }
  if (row?.kind === 'member' && text(row.repoKey) && sameRepo(row.repoKey, OATS_REPO_KEY)) return { official: true, by: ORIGIN_COPY.official, reason: 'oats-repo' };
  return { official: false, by: capabilitySource(row || {}, names).label, reason: null };
}
