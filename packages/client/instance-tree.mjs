/** The roster as a tree, from the kernel's rows alone: who is who (instanceId), who relates to whom
 * (the parent and sibling links, resolved by identity), which groups, in what order, what is visible
 * under a filter or a collapse, who waits below a collapsed row, and what holds a home. No document,
 * no element: a client draws from these answers with its own means. */
import { waitingClaim } from './waiting-on-you.mjs';
import { byRuntimeState } from './instance-presentation.mjs';
import { retireData } from './retire-state.mjs';
import { displayLine } from './display-text.mjs';
import { drawingFirst } from './same-work.mjs';

export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

/** An instance's explicit sibling link, as an array of instance names: the one reader of the kernel's
 * `siblingInstance` (string | absent, set only when a sibling relation was declared against a ROOT
 * instance — a sibling of a non-root simply shares the anchor's `parentInstance`). Normalized to an
 * array so callers are shape-agnostic; self-links and non-strings are dropped. The sidebar's
 * `instanceLinks`, `instanceSiblings` and the Desktop's Deployments graph all read the field here. */
export function siblingLinksOf(instance) {
  const raw = instance.siblingInstance;
  if (typeof raw !== "string" || !raw || raw === instance.instance) return [];
  return [raw];
}

/** Names an instance is directly related to (undirected edge endpoints):
 * its spawn parent plus its explicit sibling link (`siblingLinksOf`). Kernel
 * contract (feature/agent-relations, final): `parentInstance` and
 * `siblingInstance`. Absent fields contribute no edges. */
export function instanceLinks(instance) {
  const out = [];
  if (instance.parentInstance) out.push(instance.parentInstance);
  out.push(...siblingLinksOf(instance));
  return out.filter((name) => name && name !== instance.instance);
}

/** Stable identity for one roster instance. Instance NAMES are only unique
 * within one agents root — the kernel permits duplicate names across agent
 * dirs/team repos — so graph code must never key nodes by bare name (a
 * duplicate would silently hide a live instance; merged-state review
 * f7c5769). The canonical home path is unique per instance; agentsRoot+name
 * is the fallback; bare name only when the roster carries neither. */
export function instanceId(instance) {
  const local = instance.home ? String(instance.home)
    : instance.agentsRoot ? `${instance.agentsRoot}\u0000${instance.instance}` : String(instance.instance);
  // Canonical paths are unique only within a host. Preserve existing local keys.
  return instance.server ? `server:${instance.server}\u0000${local}` : local;
}

/** Resolve one relation-edge NAME to the id of the instance it means.
 * Relation names come from instance.json lineage, which is recorded within
 * one deployment scope — so a name resolves to the same-agentsRoot instance
 * first; a name that is globally unique resolves cross-root; an AMBIGUOUS
 * name — no same-root candidate, or MORE THAN ONE same-root candidate
 * (intra-root duplicates are legal and inherently ambiguous; merged-state
 * review @7dd1e7b) — resolves to nothing (fail safe: two separate clusters,
 * never a wrong merge, a false edge, or a hidden node).
 * EXPORTED as the one shared resolver — the hierarchy and cluster maps
 * must use the same semantics rather than re-implementing them.
 * byName: Map<name, instance[]> over the same roster. */
export function resolveLinkId(fromInstance, name, byName) {
  const candidates = byName.get(name)?.filter((i) => (i.server || "") === (fromInstance.server || ""));
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return instanceId(candidates[0]);
  const sameRoot = candidates.filter((c) => c.agentsRoot && c.agentsRoot === fromInstance.agentsRoot);
  return sameRoot.length === 1 ? instanceId(sameRoot[0]) : null;
}

/** When a row was spawned, in ms: its `createdAt` (the kernel's ISO time from instance.json), or null when it has
 * none or the reader can't parse it. */
function spawnTime(instance) {
  const time = typeof instance.createdAt === "string" ? Date.parse(instance.createdAt) : NaN;
  return Number.isFinite(time) ? time : null;
}

/** The roster's order, a comparator for `sort`: by spawn time, newest first (Pepe, 2026-11-13: "by spawn time not
 * alphabetically, i.e. new to old"); a row with no readable spawn time after every row with one; then by instance
 * name, ties broken by `instanceId`, so it is total and deterministic. It ranks roots, siblings under one parent,
 * and so clusters (by their first root: a bundle sits where its newest root sits, so a new child never moves it).
 * A spawn time never changes, so a start or a stop moves no row; only adding or removing one does (#1262's
 * recognition rule, whose name order this replaces; #1083's running-first order stays out of the roster). The one
 * place the roster's order is decided. */
function rosterOrder(a, b) {
  const ta = spawnTime(a), tb = spawnTime(b);
  if (ta !== tb) return ta === null ? 1 : tb === null ? -1 : tb - ta;
  const ia = instanceId(a), ib = instanceId(b);
  return String(a.instance).localeCompare(String(b.instance)) || (ia < ib ? -1 : ia > ib ? 1 : 0);
}

/** Each instance's siblings by EXPLICIT link (#1312): Y is X's sibling when X's sibling link
 * (`siblingLinksOf`) resolves to Y (`resolveLinkId` over `instances`), or Y's resolves to X. So both
 * ends of a link name each other. Direct links only (a chain C→B→A gives B [A, C], A [B], C [B]; A and
 * C are not inferred), self excluded, de-duplicated by instanceId, each list in the roster's order
 * (`rosterOrder`). Instances that share a parent are not siblings here (their relation is "under
 * <parent>"), and `relation`/`relativeTo` are not read: they record how an instance was spawned, not a
 * current relation. Pass one deployment's FULL roster, never a filtered list: dropping rows can turn an
 * ambiguous name into a false unique one. Returns Map<instanceId, instance[]>; an instance with no
 * sibling is absent from the map. */
export function instanceSiblings(instances) {
  const byId = new Map(instances.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  const ids = new Map(); // id -> Set of sibling ids
  const add = (a, b) => {
    if (!ids.has(a)) ids.set(a, new Set());
    ids.get(a).add(b);
  };
  for (const i of instances) {
    const id = instanceId(i);
    for (const name of siblingLinksOf(i)) {
      const other = resolveLinkId(i, name, byName);
      if (!other || other === id) continue;
      add(id, other);
      add(other, id);
    }
  }
  return new Map([...ids].map(([id, set]) => [id, [...set].map((s) => byId.get(s)).sort(rosterOrder)]));
}

/** Group instances into agent CLUSTERS — connected components of the
 * undirected relation graph (parent/child spawn edges + sibling links).
 * Unrelated instances are single-node clusters. Within a cluster the
 * parent/child tree ordering is kept (parent-first walk with depth);
 * cluster members related only by sibling links sit at depth 0.
 * Nodes are keyed by instanceId (composite identity), never bare name —
 * duplicate names across repos render as distinct nodes.
 * Under one parent, the children that draw their parent line come first (same-work.mjs `drawingFirst`: on a
 * host that declares instance-same-work, the flagged ones), each part in the roster's order (#1577). The product
 * owner's contract (awebai/oats#1577, comment 6441606665) refines the roster's order inside one parent's children only: roots, clusters and groups keep it.
 * Returns [{ key, instances: [{...instance, depth}] }] with clusters ranked by
 * their first ROOT in the roster's order (`rosterOrder`), never by another member (#1262): a bundle sits where
 * its root sits, and gaining or losing a child, or a start or a stop, moves nothing. A cluster without a root
 * (a malformed cycle) ranks by its first member in that order.
 * `roster` (optional): the full roster `instances` is a part of (#1579: one section of it). Names resolve over it,
 * so a part never turns an ambiguous name into a false unique one, and a link that resolves to a row outside the
 * part is no edge: such a row is a root of its part, as a row whose parent is gone. Without it, `instances`. */
export function clusterInstances(instances, { links = instanceLinks, roster = instances } = {}) {
  const byId = new Map(instances.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of roster) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  // undirected adjacency over IDs — unresolvable/ambiguous edges are ignored
  const adj = new Map(instances.map((i) => [instanceId(i), new Set()]));
  const parentIdOf = new Map(); // id -> resolved parent id (tree ordering)
  for (const i of instances) {
    const id = instanceId(i);
    if (i.parentInstance) {
      const pid = resolveLinkId(i, i.parentInstance, byName);
      if (pid && pid !== id) parentIdOf.set(id, pid);
    }
    for (const other of links(i)) {
      const oid = resolveLinkId(i, other, byName);
      if (!oid || oid === id || !adj.has(oid)) continue; // a link out of these rows draws nothing
      adj.get(id).add(oid);
      adj.get(oid).add(id);
    }
  }
  const rank = rosterOrder;
  const seen = new Set();
  const clusters = [];
  for (const start of [...instances].sort(rank)) {
    if (seen.has(instanceId(start))) continue;
    // collect the component
    const members = [];
    const queue = [instanceId(start)];
    seen.add(instanceId(start));
    while (queue.length) {
      const id = queue.shift();
      members.push(byId.get(id));
      for (const next of adj.get(id) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    // parent-first tree order INSIDE the component (cycle-safe: the walk
    // visits each member once; leftovers append at depth 0)
    const memberIds = new Set(members.map(instanceId));
    const kids = (p) => members.filter((i) => parentIdOf.get(instanceId(i)) === instanceId(p));
    const roots = members.filter((i) => {
      const pid = parentIdOf.get(instanceId(i));
      return !pid || !memberIds.has(pid);
    });
    roots.sort(rank);
    const ordered = [];
    const placed = new Set();
    const walk = (i, depth) => {
      if (placed.has(instanceId(i))) return;
      placed.add(instanceId(i));
      ordered.push({ ...i, depth });
      kids(i).sort((a, b) => drawingFirst(a, b) || rank(a, b)).forEach((k) => walk(k, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
    for (const i of [...members].sort(rank)) walk(i, 0); // malformed cycles must not hide members
    // Deterministic cluster label: the lexically-smallest ROOT name —
    // independent of liveness, so the visible cluster name does not flip
    // when a different member starts/stops running (review f921f7d nit).
    // `rank` (rosterOrder: by spawn time, newest first) governs display ORDER within the cluster.
    const rootNames = (roots.length ? roots : members).map((i) => i.instance).sort();
    clusters.push({ key: rootNames[0], instances: ordered, head: roots[0] ?? [...members].sort(rank)[0] });
  }
  // Stable: clusters whose heads rank equal keep the order they were found in (the roster's order of members).
  return clusters.sort((a, b) => rank(a.head, b.head)).map(({ head: _head, ...c }) => c);
}

/** `clusterInstances` output ordered by last focus (#1383; the command palette's order, never the sidebar's).
 * `lastFocus` is Map<instanceId, time>. A node's key is the latest focus time over the node and all of its
 * descendants; a node with no focus anywhere in its subtree has none. Clusters are ordered by their key, most
 * recent first, and so is each set of nodes at one level of a cluster: its depth-0 roots, and the children of
 * each parent. Nodes without a key follow every node with one, in their input order (a stable sort), so an
 * empty record returns the input order. A child stays under its parent: each cluster is walked again in
 * pre-order, every depth unchanged. A parent's children keep the roster's split (#1577): those that draw their
 * parent line first (same-work.mjs `drawingFirst`), recency deciding within each part; roots are not split. Parentage is read from the pre-order and the depths alone (a node's
 * children are the following rows one level deeper, until a row at its depth or above), never from names: the
 * tree was built by identity, and a malformed cycle's depth-0 leftovers are roots like any other. Returns new
 * cluster objects over the same rows; the input is not mutated. */
export function recencyOrder(clusters, lastFocus) {
  const timeOf = (inst) => {
    const time = lastFocus?.get(instanceId(inst));
    return Number.isFinite(time) ? time : null;
  };
  const recentFirst = (a, b) => (a.key === null ? (b.key === null ? 0 : 1) : b.key === null ? -1 : b.key - a.key);
  const ranked = clusters.map((cluster) => {
    const roots = [];
    const open = []; // the path from a root to the last row read
    for (const inst of cluster.instances) {
      const node = { inst, depth: inst.depth || 0, key: timeOf(inst), kids: [] };
      while (open.length && open.at(-1).depth >= node.depth) open.pop();
      (open.length ? open.at(-1).kids : roots).push(node);
      open.push(node);
    }
    // Keys bottom-up, then each level sorted (stable) and walked again in pre-order.
    const keyOf = (node) => {
      for (const kid of node.kids) {
        const key = keyOf(kid);
        if (key !== null && (node.key === null || key > node.key)) node.key = key;
      }
      return node.key;
    };
    const instances = [];
    const childOrder = (a, b) => drawingFirst(a.inst, b.inst) || recentFirst(a, b);
    const walk = (nodes, order) => {
      for (const node of [...nodes].sort(order)) { instances.push(node.inst); walk(node.kids, childOrder); }
    };
    const top = { key: null, kids: roots };
    keyOf(top);
    walk(roots, recentFirst);
    return { key: top.key, cluster: { ...cluster, instances } };
  });
  return ranked.sort(recentFirst).map(({ cluster }) => cluster);
}

/** Find the roster instance a UI reference means. References carry the
 * display name plus whatever identity the caller knows (home/agentsRoot —
 * sidebar rows know both; older callers pass a bare name). Identity match
 * wins; bare names resolve only when unambiguous in the roster — an
 * ambiguous bare name returns null rather than the first same-named match
 * (which could open the WRONG agents root's tmux session; review 46f3fdc).
 * Importable so the duplicate-name regression exercises this exact layer. */
export function findRosterInstance(instances, ref) {
  const name = typeof ref === "string" ? ref : ref.instance;
  const home = typeof ref === "string" ? undefined : ref.home;
  const root = typeof ref === "string" ? undefined : ref.agentsRoot;
  // An object reference names a host (absent server means local). A legacy
  // bare name can still resolve across the roster, but only if unambiguous.
  if (typeof ref !== "string") instances = instances.filter((i) => (i.server || "") === (ref.server || ""));
  if (home) {
    const byHome = instances.find((i) => i.home === home);
    if (byHome) return byHome;
  }
  if (root) {
    const byRoot = instances.find((i) => i.instance === name && i.agentsRoot === root);
    if (byRoot) return byRoot;
  }
  const named = instances.filter((i) => i.instance === name);
  return named.length === 1 ? named[0] : null;
}

/** Shortest DISTINGUISHING path suffixes for a set of agents roots.
 * Duplicate instance names are told apart by where they home, but naive
 * single-segment tags collide (/a/project/agents and /b/project/agents both
 * render "project"). Grow each root's suffix segment-by-segment until it is
 * unique within the set; fall back to the full root. Returns Map<root, tag>.
 * (Review cbd5bb3: duplicate option labels must actually differ.) */
export function distinguishingRootTags(roots) {
  const uniq = [...new Set(roots.filter(Boolean).map(String))];
  const segs = new Map(uniq.map((r) => [r, r.split("/").filter(Boolean)]));
  const tags = new Map();
  for (const root of uniq) {
    const mine = segs.get(root);
    // skip the trailing "agents"-style leaf shared by every root: start the
    // suffix ABOVE the leaf, then extend upward until unique
    let take = 2; // leaf + one parent
    let tag;
    for (; take <= mine.length; take++) {
      tag = mine.slice(-take, -1).join("/");
      const clash = uniq.some((other) => other !== root
        && segs.get(other).slice(-take, -1).join("/") === tag);
      if (!clash) break;
    }
    tags.set(root, take > mine.length || !tag ? root : tag);
  }
  return tags;
}

/** Whether an instance has children IN ITS OWN identity — parent edges
 * resolve through resolveLinkId, so a childless parent whose NAME is shared
 * by a parent in another agents root gets no disclosure control (review
 * 7d740f9). Accepts the full instance object; the legacy bare-name call
 * shape (string) keeps name matching for rosters without identity fields. */
export function hasInstanceChildren(instances, instance) {
  if (typeof instance === "string") {
    return instances.some((candidate) => candidate.parentInstance === instance);
  }
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  const id = instanceId(instance);
  return instances.some((candidate) => candidate.parentInstance
    && resolveLinkId(candidate, candidate.parentInstance, byName) === id);
}

export function instanceRepoLabel(instance) {
  if (instance.repoName) return String(instance.repoName);
  const path = instance.repo || instance.workspace || "";
  return String(path).split("/").filter(Boolean).at(-1) || "workspace";
}

/* ── homes the kernel holds (#802) ── */

const HELD_HOMES = Object.freeze({
  spawning: { state: "Setting up worktree…", status: "Spawning (setting up worktree)", retire: false,
    sentence: name => `${name} is setting up its worktree. It can't be used until the spawn finishes.` },
  "spawn-incomplete": { state: "Spawn didn't finish", hint: "Retire it to clean up", status: "Spawn didn't finish", retire: true,
    sentence: name => `The spawn of ${name} didn't finish. Retire it to clean up.` },
  // #1247: a retire that runs (or whose holder's liveness can't be read): Retire stays offered, secondary.
  retiring: { state: "Retiring…", status: "Retiring…", retire: "secondary",
    sentence: name => `${name} is being retired.` },
  "retire-failed": { state: "Retire failed", hint: "Retire it again to finish", status: "Retire failed", retire: true,
    sentence: name => `The retire of ${name} failed. Retire it again to finish.` },
  "retire-incomplete": { state: "Retire didn't finish", hint: "Retire it again to complete", status: "Retire didn't finish", retire: true,
    sentence: name => `The retire of ${name} didn't finish. Retire it again to complete.` },
});
/** Which retire kind a row's kernel facts are (#1247), or null: the kernel's `retire` (retire-state.mjs, read
 * again here: a value out of the contract is absent); a row with no `retire` but `retirePending` (a kernel or a
 * host before `status-retire-state`) reads `retiring`. */
function retireKind(instance) {
  const retire = retireData(instance.retire);
  if (retire) return retire.state === "failed" ? "retire-failed" : retire.state === "interrupted" ? "retire-incomplete" : "retiring";
  return instance.retirePending ? "retiring" : null;
}
/** What the kernel's roster row says holds this home, or null (#802, #1247): `spawning` while a spawn
 * that runs its worktree hooks is verifiably alive (`spawnInProgress: true`), `spawn-incomplete` when a
 * spawn left it for retire to clean up (`rollbackIncomplete`); then the retire kinds (`retireKind`):
 * `retiring` while a retire runs, its holder can't be read, the row is an older kernel's `retirePending`
 * or this client's own retire is in flight; `retire-failed` when a self-retire's completion recorded an
 * error; `retire-incomplete` when a scheduled completion is gone without an outcome. A retire this client
 * started and has not read the roster after (retire-in-flight.mjs `retireInFlight`) is `retiring` whatever
 * the row says: it is the newest fact, and the kernel refuses it (letting the row go) where a live spawn
 * holds the home. Of the kernel's facts, rollbackIncomplete wins over spawnInProgress (the spawn is gone,
 * not live), and a live spawn over a retire (the kernel refuses to retire it). Every surface draws such a row from this: a spawning or retiring one starts,
 * stops, restarts and opens nothing new; one with `retire` offers Retire only, and `retire: "secondary"`
 * (retiring: a second retire is refused while one runs, and safe) offers it out of the way (instance-acts.mjs).
 * `state` is the row's text, `hint` its muted line (none while retiring), `status` the hover card's Status.
 * `sentence` is every client's, so it promises no act of one client: a spawning home "can't be used until
 * the spawn finishes", whoever started the spawn and whether or not it ends finished. `said` is what the
 * row's reason says (instance-acts.mjs): the sentence, or for a failed retire with a recorded message or code the
 * kernel's words (`message`, `code`, or `message (code)`) with `origin: "kernel"`, shown only through the display
 * filter. */
export function heldHome(instance) {
  const kind = !instance ? null : instance.retireInFlight === true ? "retiring" : instance.rollbackIncomplete ? "spawn-incomplete"
    : instance.spawnInProgress === true ? "spawning" : retireKind(instance);
  if (!kind) return null;
  const held = HELD_HOMES[kind], retire = kind === "retire-failed" ? retireData(instance.retire) : null;
  // The kernel's words, message or code, are said as the kernel's, and shown only through the display filter; one the
  // filter reduces to nothing (blank) says nothing; one it withholds is said, and shown withheld. With neither, the row's own words stand.
  const shown = text => (text && displayLine(text) !== null ? text : null);
  const message = shown(retire?.message), code = shown(retire?.code);
  const said = message || code ? { sentence: message && code ? `${message} (${code})` : message || code, origin: "kernel" }
    : { sentence: held.sentence(instance.instance) };
  return { kind, ...held, said };
}

/* ── roster grouping: repo → agent family (soul), with sort modes ── */

export const ROSTER_SORTS = Object.freeze([
  Object.freeze({ id: "status", label: "Status (running first)" }),
  Object.freeze({ id: "name", label: "Name" }),
]);

/** Comparator for one sibling level. "status" is `byRuntimeState` (running, unknown, stopped, then by name:
 * #1083's order, which the roster no longer uses, #1262); "name" is purely alphabetical. No client calls it. Unknown ids fall back to "status" so a stale persisted choice
 * can never break rendering. */
export function rosterRank(sortBy) {
  const byName = (a, b) => String(a.instance).localeCompare(String(b.instance));
  if (sortBy === "name") return byName;
  return byRuntimeState;
}

/** Group a roster list repo → agent family (soul), each family's items in
 * lineage order (parents before children, depth annotated) with siblings
 * sorted by `sortBy` (those that draw their parent line first, #1577). Lineage links crossing family/repo boundaries are cut:
 * such children render as roots of their own family group. Returns
 * Map<repoLabel, Map<familyName, item[]>> with deterministic group order:
 * repos and families alphabetical. */
export function groupRosterFamilies(list, sortBy = "status") {
  const rank = rosterRank(sortBy);
  const repos = new Map();
  for (const i of list) {
    // instance.json is workspace-controlled: agent/repoName may arrive as
    // non-strings through the reader. Coerce grouping keys so one malformed
    // instance cannot throw in localeCompare and blank the whole roster.
    const rName = String(instanceRepoLabel(i));
    if (!repos.has(rName)) repos.set(rName, new Map());
    const families = repos.get(rName);
    const fName = String(i.agent || "?");
    if (!families.has(fName)) families.set(fName, []);
    families.get(fName).push(i);
  }
  const sortedRepos = new Map([...repos.entries()].sort(([a], [b]) => a.localeCompare(b)));
  for (const [rName, families] of sortedRepos) {
    const sortedFamilies = new Map([...families.entries()].sort(([a], [b]) => a.localeCompare(b)));
    for (const [fName, items] of sortedFamilies) {
      const byName = new Map(items.map((i) => [i.instance, i]));
      const roots = items.filter((i) => !i.parentInstance || !byName.has(i.parentInstance));
      const kids = (p) => items.filter((i) => i.parentInstance === p.instance);
      const ordered = [];
      const seen = new Set();
      const walk = (i, depth) => {
        if (seen.has(i.instance)) return; // cycle-safe
        seen.add(i.instance);
        ordered.push({ ...i, depth });
        // #1577: children that draw their parent line first, as clusterInstances orders them.
        kids(i).sort((a, b) => drawingFirst(a, b) || rank(a, b)).forEach((k) => walk(k, depth + 1));
      };
      roots.sort(rank).forEach((r) => walk(r, 0));
      for (const i of items) if (!seen.has(i.instance)) ordered.push({ ...i, depth: 0 });
      sortedFamilies.set(fName, ordered);
    }
    sortedRepos.set(rName, sortedFamilies);
  }
  return sortedRepos;
}

/** Stable collapse key for a roster GROUP header (repo or repo+family),
 * workspace-scoped like instance collapse keys. */
export function rosterGroupKey(workspace, ...parts) {
  return [`g:${workspace || ""}`, ...parts].join("\u0000");
}

/** Whether an instance itself matches the roster filter (its name, soul or repository) — as
 * opposed to an ancestor shown only to keep a match's tree path. */
export function instanceMatchesFilter(item, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [item.instance, item.agent, item.repoName]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

/** Include matching instances plus their ancestor paths, in source order.
 * IDENTITY-aware (merged-state review @3e76616): inclusion keys by
 * instanceId and ancestors resolve through resolveLinkId over the FULL
 * roster — a same-named instance in another root never leaks into this
 * one's filter results, and an ambiguous parent edge includes nothing.
 * `matches` decides what matches (default: the sidebar's instanceMatchesFilter);
 * the command palette passes its fuzzy matcher and shares the tree path. */
export function filterInstanceTree(instances, query, matches = null) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return instances;
  const isMatch = matches || ((item) => instanceMatchesFilter(item, needle));
  const byId = new Map(instances.map((item) => [instanceId(item), item]));
  const byName = new Map();
  for (const item of instances) {
    if (!byName.has(item.instance)) byName.set(item.instance, []);
    byName.get(item.instance).push(item);
  }
  const included = new Set();
  for (const item of instances) {
    if (!isMatch(item)) continue;
    let cursor = item;
    const seen = new Set();
    while (cursor) {
      const id = instanceId(cursor);
      if (seen.has(id)) break;
      included.add(id);
      seen.add(id);
      const pid = cursor.parentInstance ? resolveLinkId(cursor, cursor.parentInstance, byName) : null;
      cursor = pid ? byId.get(pid) : null;
    }
  }
  return instances.filter((item) => included.has(instanceId(item)));
}

/** Cluster the FULL roster, then project each cluster to its visible
 * members — never cluster a filtered subset: dropping roster rows can turn
 * a globally AMBIGUOUS relation edge into a false unique edge, silently
 * re-linking nodes while the user types (merged-state review @3e76616).
 * Cluster order and member depths come from the full-roster computation;
 * clusters with no visible member disappear. */
export function visibleClusters(allInstances, visibleInstances, { links = instanceLinks } = {}) {
  const visibleIds = new Set(visibleInstances.map((i) => instanceId(i)));
  return clusterInstances(allInstances, { links })
    .map((c) => ({ ...c, instances: c.instances.filter((i) => visibleIds.has(instanceId(i))) }))
    .filter((c) => c.instances.length);
}

/** The sidebar roster's groups (Redesign v3), shared with the command palette and the TUI: the full roster's
 * clusters in their one order (#1262), each multi-member relation cluster a group under its deterministic name,
 * and each RUN of consecutive single-instance clusters one "independent" group, in place. So an instance that
 * gains its first child stays where it was and becomes a group there; losing its last child, it rejoins the run
 * at the same place. A cluster's group is decided on the FULL roster: a filter or a collapse decides which rows
 * are listed and never moves a row to another group; a group with no visible row is left out. Returns
 * [{ key, label, clusters: [{ key, instances }] }], each cluster projected to its visible members, which carry
 * their tree depth. A group's key is unique even when two roots share a name (other agents roots or hosts), and
 * does not depend on what is visible: a cluster's is `cluster:<its place among the full roster's multi-member
 * clusters>:<name>`, a run's `independent:<instanceId of its first member in the full roster>`.
 * `lastFocus` (Map<instanceId, time>, optional; the command palette's, #1383): the full roster's clusters are
 * ordered by last focus (`recencyOrder`) before the groups form by the same rule, so a run is the consecutive
 * single clusters of that order, keyed by its first member there. What is visible still decides only which rows
 * are listed, never the order. Without it, the roster's own order (the sidebar's and the TUI's).
 * `roster` (optional): the full roster `allInstances` is a part of, as for `clusterInstances`. */
export function rosterGroups(allInstances, visibleInstances, { links = instanceLinks, lastFocus, roster = allInstances } = {}) {
  const visibleIds = new Set(visibleInstances.map((i) => instanceId(i)));
  const groups = [];
  let place = 0, run = null;
  const clusters = clusterInstances(allInstances, { links, roster });
  for (const c of lastFocus instanceof Map ? recencyOrder(clusters, lastFocus) : clusters) {
    const shown = { ...c, instances: c.instances.filter((i) => visibleIds.has(instanceId(i))) };
    if (c.instances.length > 1) {
      run = null;
      const at = place++;
      if (shown.instances.length) groups.push({ key: `cluster:${at}:${c.key}`, label: c.key, clusters: [shown] });
      continue;
    }
    if (!run) { run = { key: `independent:${instanceId(c.instances[0])}`, label: "independent", clusters: [] }; groups.push(run); }
    if (shown.instances.length) run.clusters.push(shown);
  }
  return groups.filter((g) => g.clusters.length);
}

/** The kernel feature that reports a row's `background` (#1579). */
export const BACKGROUND_FEATURE = "instance-background";

/** The rows the Background section holds (#1579; Pepe, 2026-10-27): a row whose own `background` is exactly
 * `true`, or one with such an ancestor in its `parentInstance` chain among the rows present (resolved by
 * identity, resolveLinkId over the FULL roster, cycle-safe; a parent that resolves to nothing ends the chain).
 * So a background row's children stay under it whatever their own value. Placement only: a row's own flag is
 * read, never changed (no inheritance). `enabled`: the CLI lists `instance-background`; without it the set is
 * empty whatever a row carries (a stray field is ignored). Returns Set<instanceId>. */
export function backgroundPlacement(instances, enabled) {
  const out = new Set();
  if (!enabled) return out;
  const byId = new Map(instances.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  const known = new Map(); // instanceId -> placed in Background
  for (const row of instances) {
    // Walk up until a background row, a row already decided, the top, or a cycle; every row walked shares the answer.
    const path = [], seen = new Set();
    let cursor = row, placed = false;
    while (cursor) {
      const id = instanceId(cursor);
      if (known.has(id)) { placed = known.get(id); break; }
      if (seen.has(id)) break;
      seen.add(id); path.push(id);
      if (cursor.background === true) { placed = true; break; }
      const pid = cursor.parentInstance ? resolveLinkId(cursor, cursor.parentInstance, byName) : null;
      cursor = pid ? byId.get(pid) : null;
    }
    for (const id of path) known.set(id, placed);
  }
  for (const [id, placed] of known) if (placed) out.add(id);
  return out;
}

/** Whether an item remains visible under VS Code-style collapsed ancestors.
 * Filtering temporarily reveals matching paths without mutating the user's
 * persisted collapse state. Parent traversal is cycle-safe and
 * IDENTITY-aware: collapse keys are minted from instanceId, and parent
 * names resolve through resolveLinkId so a collapsed duplicate name in
 * another agents root can never hide this root's subtree (review 46f3fdc).
 * `section(row)` (optional): the roster section (deployment) a row is painted in. A collapse hides only
 * rows of its own section: the walk stops at the first ancestor painted in another section, which does
 * not hide the row (#551's visible symptom: resolveLinkId accepts a unique name from another agents root,
 * and that parent is painted, and collapsed, in another section). Without it, sections are ignored. */
export function instanceVisibleInTree(instance, allInstances, collapsed, workspace, filtering = false, { section } = {}) {
  if (filtering) return true;
  const byId = new Map(allInstances.map((item) => [instanceId(item), item]));
  const byName = new Map();
  for (const item of allInstances) {
    if (!byName.has(item.instance)) byName.set(item.instance, []);
    byName.get(item.instance).push(item);
  }
  const seen = new Set([instanceId(instance)]);
  let cursor = instance;
  while (cursor?.parentInstance) {
    const pid = resolveLinkId(cursor, cursor.parentInstance, byName);
    if (!pid || seen.has(pid)) break;
    const parent = byId.get(pid);
    if (section && parent && section(parent) !== section(instance)) break;
    if (collapsed.has(collapseKey(workspace, pid))) return false;
    seen.add(pid);
    cursor = parent;
  }
  return true;
}

/** Needs input (Spec D): waiting instances hidden by a collapse, attributed to their nearest visible ancestor:
 * Map(instanceId(ancestor) → [waiting rows]). Computed over the full roster (as clustering is) by the
 * parent relation only (resolveLinkId: never across a remote server), cycle-safe; a missing or cyclic
 * parent chain degrades to no roll-up. `section(row)`: the roster section (deployment) a row is painted
 * in; a chain that leaves the waiting row's section rolls up nowhere (resolveLinkId accepts a unique name
 * from another agents root), and a collapse in another section does not hide it (instanceVisibleInTree,
 * given the same `section`). Filtering on → nothing is collapsed → empty. `stale(row)`: the caller's
 * held-stale test; a stale row contributes nothing. */
export function waitingRollup(instances, collapsed, workspace, { filtering = false, stale = () => false, section = () => null } = {}) {
  const out = new Map();
  if (filtering || !collapsed?.size) return out;
  const byId = new Map(instances.map(i => [instanceId(i), i]));
  const byName = new Map();
  for (const i of instances) { if (!byName.has(i.instance)) byName.set(i.instance, []); byName.get(i.instance).push(i); }
  for (const i of instances) {
    if (!waitingClaim(i, { stale: stale(i) }) || instanceVisibleInTree(i, instances, collapsed, workspace, false, { section })) continue;
    const seen = new Set([instanceId(i)]);
    let cursor = i, owner = null;
    while (cursor?.parentInstance) {
      const pid = resolveLinkId(cursor, cursor.parentInstance, byName);
      if (!pid || seen.has(pid)) break;
      seen.add(pid); cursor = byId.get(pid);
      if (!cursor || section(cursor) !== section(i)) break;
      if (instanceVisibleInTree(cursor, instances, collapsed, workspace, false, { section })) { owner = pid; break; }
    }
    if (owner === null) continue;
    if (!out.has(owner)) out.set(owner, []);
    out.get(owner).push(i);
  }
  return out;
}

/** Resolve the roster keyboard handler's ArrowLeft target: the parent
 * instanceId of the row whose data-tree-instance is `id`, or null.
 * Identity-aware end to end (review 96b037b): the current row is found by
 * instanceId — rows carry composite ids, so a bare-name lookup never
 * matches — and the parent edge resolves through resolveLinkId, so a
 * duplicate parent name in another root (or intra-root) can never steal
 * focus: ambiguity yields null and the key is a no-op. */
export function rosterParentId(instances, id) {
  const me = instances.find((i) => instanceId(i) === id);
  if (!me?.parentInstance) return null;
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  return resolveLinkId(me, me.parentInstance, byName);
}
