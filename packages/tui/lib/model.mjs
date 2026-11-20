// From the store's state to what is drawn: the roster in its order, the rows of the pane and the
// facts of the selected instance. Pure, and without a cell position: the views place it.
//
// Everything that groups, orders, hides or names an instance is asked of the shared home
// (client.mjs), the same functions the Desktop draws from: this module calls them and flattens
// their answers, and holds no rule of its own about which group a row is in or what state it is
// in. What it adds is the TUI's: the window, the clock times, and which fact stands on which line.
import {
  TERMS, panelData, localDeploymentIds, displayLine, DETAIL_WITHHELD, originLead, instanceId, instanceVisibleInTree, waitingRollup, collapseKey, filterInstanceTree,
  hasInstanceChildren, heldHome, instanceSiblings, siblingText, rosterSections, rosterSectionKey, sidebarSections, backgroundPlacement, BACKGROUND_FEATURE, PIN_FEATURE, deploymentState, rowStale, primaryDeployment, isMultiDeployment, runtimeState, runtimeCounts, instanceColor, instanceDisplayName,
  waitingClaim, waitingLabel, waitedText, waitingClock, waitingBelowText, instanceActs, rowReason,
  identityMemory, viewModel, listedViews, workspaceChoices, workspaceChoiceRows, choiceMatches, UNMATCHED_SECTION, shortPath, machineLabels,
  openAct, deployments as heldDeployments, localScrollKeys, hostScrollKeys, attachExit, preflightFailure, kernelLines,
  startGate, launchFlagIgnored, flagIgnoredNotice, retainedStartMessage, retiringRows, soulRows, soulFacts, spawnRefusal,
  defaultSpawnChoices, spawnProblem, outcomeWords, previewFacts, deploymentLabel, subsequenceScore, soulMatches, soulCatalogFailure, catalogFailure,
  memberNames, capabilitySource, groupCapabilities, hostKeyOf, capabilitySections, matchCapabilities, soulsComposition, rosterAgentName, layerLabel, capabilityUsers,
  capabilityFacts, CAPABILITY_COPY, CHORD_FAMILY_LABELS, DEFAULT_CHORD_FAMILY, chordFamilyNote,
} from "./client.mjs";
import { LEADER, chordsRead, keyLabel } from "./actions.mjs";
import { ownEllipsis, shownLines } from "./term/text.mjs";
import { textWidth } from "./term/width.mjs";
import { windowOf } from "./views/scroll.mjs";
import { SOUL_COLOURS } from "./views/souls.mjs";
import { leadRows } from "./views/switcher.mjs";

/** The widest the word column of the list may be, in cells. */
export const WORD_MAX = 20;
/** The most rows one sentence takes inside the list (a deployment's note, a reason). */
const SENTENCE_ROWS = 4;
/** The cells a sentence inside the list is set in from the pane's left edge. */
export const SENTENCE_INDENT = 3;
/** The width the list is flattened for when nobody says: only the rows that can be selected are
 *  read from such an answer, and they are the same at every width. */
const ANY_WIDTH = 80;

/** What the shared home reads of a client (panel-views.mjs `held`), built here and nowhere else.
 *  `snapshot.byWs` holds this machine's entries only: a machine's panel is made by the shared
 *  home itself from `remoteGroups`, stamped with `at`. So `at` is the time of the last roster
 *  outcome the store took (`rosterAt`): a machine's rows are what it reported then. Before any
 *  outcome there is no machine to stamp, and the time of the call stands in. */
export function heldOf(state, at) {
  return {
    ctxs: state.ctxs, snapshot: { byWs: state.entries }, remoteGroups: state.remote.remoteGroups,
    remembered: identityMemory({ memory: state.memory, notes: state.notes }),
    rosterAnswered: state.remote.rosterAnswered, rosterFailure: state.remote.rosterFailure, cli: state.cli,
    observing: new Set(), remoteCollecting: state.collecting, home: state.home, at: state.rosterAt ?? at,
    // What the identity reads learned of this computer's listed deployments (lib/main.mjs): a listed one is
    // matched to its workspace in the switcher, and one opened from there is in its view before its first read.
    learned: state.identities,
  };
}

/** The panel of the view that holds `state.open`: the composition the Desktop's own panel is
 *  served from (panel-views.mjs `panelData`), so nothing of it is put together by hand here.
 *  Null while nothing is open (a run started outside a deployment, before a pick). Its rows are
 *  as read: this run's retires in flight are put on them by `build` alone. */
export function panelOf(state, at) {
  return state.open === null ? null : panelData(heldOf(state, at), state.open, TERMS);
}

/** What the shared resume trigger observes after a read of served deployment `id` (lib/main.mjs): the rows of
 *  the view that holds it, each tagged with its deployment, and the ids of that view's deployments of this
 *  machine, as the Desktop's panel gives them (panel-views.mjs `panelData`, session-resume-trigger.mjs
 *  `localDeploymentIds`). Another machine's rows in the view are there, and are never local. */
export function resumeObservation(state, id, at) {
  const panel = panelData(heldOf(state, at), id, TERMS);
  return { rows: panel.instances ?? [], localDeploymentIds: localDeploymentIds(panel) };
}

/** The workspace (the shared view's id: panel-views.mjs viewModel) that holds deployment `id` in `state`,
 *  or null: what the tabs belong to, so a change of `state.open` within one workspace (its deployment of
 *  this machine opened beside another machine's) is not taken for opening another. */
export function workspaceOf(state, id, at) {
  if (id === null) return null;
  return viewModel(heldOf(state, at), TERMS).views.find((v) => v.id === id || v.deployments.includes(id))?.id ?? null;
}
/** What a workspace's memory for the run is kept under (docs/tui.md, "Tabs"): the workspace that
 *  holds deployment `id` (workspaceOf), so another of its deployments finds the same memory; a
 *  deployment that reports no workspace, by its own id. Null for no deployment. */
export const memoryKey = (state, id, at) => (id === null ? null : workspaceOf(state, id, at) ?? id);
/** The palette's recency of the open workspace (`recent`, per memoryKey): its instances opened or
 *  shown in this run, the latest first. */
export const recentOf = (state, at) => state.recent.get(memoryKey(state, state.open, at)) ?? [];
/** The memoryKeys the views hold now (each view's id, and its deployments'), and the one each
 *  deployment whose read failed with nothing kept was in when it was last read (`unreadKeys`): it is
 *  in no view but its own until it is read again, so that view may only seem gone. */
export function memoryKeys(state, at) {
  return new Set([...viewModel(heldOf(state, at), TERMS).views.flatMap((v) => [v.id, ...v.deployments]), ...state.unreadKeys.values()]);
}

const text = (value) => typeof value === "string" && value !== "";
const pad = (n) => String(n).padStart(2, "0");
/** An ISO time as a local clock time, `14:03:27`, or null. */
export function clockTime(iso) {
  const at = new Date(iso);
  return text(iso) && Number.isFinite(at.getTime()) ? `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` : null;
}

/** The deployments of other machines whose rows the last roster outcome read (their group's probe
 *  answered), by the ids the shared `deployments` gives them, which a row's `deployment.id` carries:
 *  what a roster outcome covers of this run's retires in flight (lib/main.mjs). */
export function reachedMachines(state, at) {
  return new Set(heldDeployments(heldOf(state, at)).filter((w) => w.remote && w.group?.probe?.ok === true).map((w) => w.id));
}

/** A row's state in a word: the one the kernel or the collector reported on the row, else the
 *  shared word for what is known of it (running, stopped, unknown). A row kept from a machine
 *  that was not reached (the shared home marks it) still carries the word of its last report,
 *  which is not its state now: it gets the shared word, so nothing reads as stopped, or as
 *  running, that is only not reached. */
const stateWord = (row) => (text(row.runtimeState) && row.serverUnreached !== true && !providerKnown(row) ? row.runtimeState : runtimeState(row));
/** A row on a session provider (the shared openAct's `no-terminal`) whose `running` the kernel answered: its
 *  `runtimeState` is the provider's word (`unknown` while it runs), which would contradict its mark, so its
 *  state is the shared word for its `running`. One the kernel answered `running: null` keeps the kernel's word. */
const providerKnown = (row) => typeof row.running === "boolean" && openAct(row)?.reason?.code === "no-terminal";
/** The word a list row shows beside its name, or null: only what its mark cannot say. That is a
 *  held home's state (Retiring… while a retire runs, or this run's own is in flight), else the
 *  shared label of the reason the row can't be reached or opened (remote-address.mjs rowReason:
 *  `gone from <machine>`, `<machine> not reached`, `state unknown`, …). A row that runs, is
 *  stopped, or keeps a shell has no word: its mark says it, and its harness is in the detail. */
function wordOf(row, ascii) {
  const held = heldHome(row);
  return held ? ownEllipsis(held.state, ascii) : rowReason(row)?.label ?? null;
}
/** The detail's state: the list's word when it is a held home's state or the label of a reason
 *  the row can't be reached (a row gone from its machine reads `gone from <machine>`, not
 *  `unknown`); else the word the kernel or the collector reported, else the shared word. The
 *  reason that says only that the state is not known gives way to the kernel's own word for it
 *  (`unreachable`), which says more. */
function detailState(row, ascii) {
  const held = heldHome(row);
  if (held) return ownEllipsis(held.state, ascii);
  const reason = rowReason(row);
  return reason && reason.key !== "unknown" ? reason.label : stateWord(row);
}
/** Which mark a row carries: the shared word, `held` for a home the kernel holds, and `shell`
 *  for a stopped instance whose terminal still has a shell in it. */
function markOf(row) {
  if (heldHome(row)) return "held";
  const word = runtimeState(row);
  return word === "stopped" && row.runtimeState === "shell" ? "shell" : word;
}

/** An instance row's colour (feature instance-color) as one of the terminal's sixteen, through the souls'
 *  map (views/souls.mjs SOUL_COLOURS), or null: which colour a row shows is the shared rule (instanceColor). */
const rowColour = (row) => SOUL_COLOURS[instanceColor(row)] ?? null;

/** The id the Background section's heading is selected by (#1579): it stands in `state.selected` as an
 *  instance's id does, so the movement keys stop on it. No instanceId can be it: a home and an agents root
 *  are paths, an instance's name is made of letters, digits and `-`, and none starts with NUL. */
export const BACKGROUND_ID = "\u0000background";
/** Whether the Background section of workspace `open` is drawn open in `state`: closed in every new run,
 *  and kept for the run per workspace as `collapsed` is (by `state.open`): `state.background` holds the
 *  ones open. */
export const backgroundOpen = (state) => state.background.has(state.open);
/** Whether this run's kernel lists the pin's feature (instance-pin): a row's `pinned` orders the list only then. */
export const pinsListed = (state) => Array.isArray(state.cli?.features) && state.cli.features.includes(PIN_FEATURE);

/** The key prefix of each run of instances related to no other, as the shared grouping names it
 *  (`independent:<id>`). Read by key, not by label: a cluster whose root is named `independent` has that
 *  label too, and its key is `cluster:<n>:independent`. */
const SINGLES = "independent:";

/** Everything of a state that does not depend on a width: the panel, the rows as the shared
 *  grouping orders them, the headings, and what stands after the sections. */
function build(state, at) {
  const panel = panelOf(state, at);
  // No view holds what was open (a machine that is no longer listed): the store shows the
  // switcher for it; nothing is drawn from this answer.
  const gone = panel !== null && !panel.workspace;
  // A row whose retire this run sent and has not read since reads as retiring (#1247): every answer
  // below, the acts included, is made from these rows.
  const instances = retiringRows(panel?.instances ?? [], state.retiring), deployments = panel?.deployments ?? [];
  const multi = isMultiDeployment(deployments);
  // The filter: the text typed after `/`, or the exact soul filter the Souls view's `i` sets
  // (`soul`: the names an instance's soul may carry), matched by the shared walk all the same.
  const query = state.filter.query, soul = state.filter.soul ?? null, filtering = query.trim() !== "" || soul !== null;
  // `ordered`: every row in the shared order of the whole roster, whatever is filtered, folded or in the
  // Background section (the lists of a soul's instances read it).
  const ordered = [];
  // Pinned first (feature instance-pin), as in the Desktop: only when this run's kernel lists the feature; without
  // it a row's `pinned` is ignored and the order is the roster's own.
  const pins = pinsListed(state);
  for (const part of rosterSections(instances, instances, deployments, TERMS, { pins })) for (const group of part.groups) for (const cluster of group.clusters) ordered.push(...cluster.instances);
  // The rows the Background section holds (#1579), the shared placement's: only when this run's kernel
  // lists the feature; without it a row's `background` is ignored and nothing below changes.
  const placement = backgroundPlacement(instances, Array.isArray(state.cli?.features) && state.cli.features.includes(BACKGROUND_FEATURE));
  // The section each row is drawn in, as the shared key says it: its deployment's, in the main tree or in
  // the Background section. A collapse hides, and rolls up, only rows of its own section, as in the
  // Desktop: a parent's name can resolve to a row of another deployment of the view, or of the other part.
  const section = rosterSectionKey(deployments, placement);
  // Each instance's siblings by explicit link, both ends, as the shared home resolves them (#1312):
  // asked of each deployment's full roster on its own, whatever is filtered, folded or in the Background
  // section, so a name never resolves to an instance of another deployment, nor a row of the other part
  // left out makes an ambiguous name unique. The key without a placement is the deployment's alone.
  const deploymentOf = rosterSectionKey(deployments), bySection = new Map();
  for (const row of instances) { const key = deploymentOf(row); if (!bySection.has(key)) bySection.set(key, []); bySection.get(key).push(row); }
  const siblings = new Map([...bySection.values()].flatMap((own) => [...instanceSiblings(own, { pins })]));
  const matched = soul !== null ? filterInstanceTree(instances, soul.name, (row) => soul.names.includes(row.agent)) : filterInstanceTree(instances, query);
  const visible = matched.filter((i) => instanceVisibleInTree(i, instances, state.collapsed, state.open, filtering, { section }));
  const stale = (row) => rowStale(row, deployments);
  // The main tree's sections, and the Background section after them, each a tree of its own (the shared
  // sidebarSections). A filter draws the section open, so its matches show, and changes nothing stored;
  // the heading counts the rows the filter leaves in it.
  const { main: sections, background } = sidebarSections(instances, visible, deployments, TERMS, { placement, open: backgroundOpen(state) || filtering, listed: matched, stale, pins });
  // How many instances each collapse folds away under its row: every descendant of the row in its
  // own section, as the shared walk finds them when it is asked with that collapse alone (so a
  // fold further down hides none of them from the count). A filter folds nothing away.
  const folded = new Map();
  if (!filtering) for (const row of visible) {
    const key = collapseKey(state.open, instanceId(row));
    if (!state.collapsed.has(key)) continue;
    const alone = new Set([key]);
    folded.set(instanceId(row), instances.filter((other) => !instanceVisibleInTree(other, instances, alone, state.open, false, { section })).length);
  }
  const primary = primaryDeployment(deployments), said = deploymentState(primary);
  const live = primary !== null && said.key === "live";
  // The time of the read the screen shows: the cycle's own (`generatedAt`), never
  // `observedAt`, which is when the kernel last looked at the workspace's remotes and is up
  // to a minute older on a read in the background. Nothing drawn here comes from the remotes.
  // In a view whose primary is a machine it is the time of the last roster read (heldOf).
  const readAt = live ? clockTime(panel.generatedAt) : null;

  // The list, top to bottom, before any width. A section that has a label (a view of two or more
  // deployments) starts with its heading and the deployment's note; then the groups in the order
  // given, every cluster's members in order, with one gap at every boundary between a run of single
  // instances and a cluster, both ways (#1262).
  const parts = [], rows = [];
  const drawn = (part, background = false) => {
    if (text(part.label)) {
      parts.push(heading(part.deployment, part.label));
      if (text(part.deployment.note)) parts.push({ kind: "sentence", value: part.deployment.note });
    }
    let previous = null; // whether the group drawn last was a run of single instances
    for (const group of part.groups) {
      // A gap at every boundary between a run of single instances and a cluster, both ways (#1262).
      const singles = group.key.startsWith(SINGLES);
      if (previous !== null && singles !== previous) parts.push({ kind: "gap" });
      previous = singles;
      for (const cluster of group.clusters) for (const row of cluster.instances) {
        const item = { kind: "row", row, id: instanceId(row), depth: Number.isInteger(row.depth) ? row.depth : 0, ...(background ? { background: true } : {}) };
        parts.push(item); rows.push(item);
      }
    }
  };
  const heading = (deployment, label, path = null) => {
    const its = deploymentState(deployment), up = its.key === "live";
    // A machine's rows are what it reported at the last roster read: that time stands on its
    // heading only when the time of this read (the help's top row) is another, so the heading of a machine read with
    // this one is its name alone. A deployment that is not live has its state and short reason
    // in the shared words instead, and no time.
    const read = up && deployment.local === false ? clockTime(state.rosterAt) : null;
    return {
      kind: "heading", label, path, state: up ? null : its.text, short: up || !text(deployment.short) ? null : deployment.short,
      readAt: read !== readAt ? read : null,
    };
  };
  for (const part of sections) drawn(part);
  // A deployment of the view that is not live and has no row is in no section: it is named
  // after them, with its state, and its reason on rows of its own. One whose rows are all in the
  // Background section has its heading there while the section is open; closed, it is named here, so
  // that it is not reached is still said.
  const held = new Set(background?.sections.map((part) => part.deployment?.id) ?? []);
  if (multi) for (const deployment of deployments) {
    const its = deploymentState(deployment);
    if (its.key === "live" || sections.some((part) => part.deployment?.id === deployment.id) || held.has(deployment.id)) continue;
    parts.push(heading(deployment, deployment.machine, deployment.label));
    if (text(its.detail)) parts.push({ kind: "sentence", value: its.detail });
    if (text(deployment.note)) parts.push({ kind: "sentence", value: deployment.note });
  }
  // The Background section (#1579), after the whole main tree: its heading, which can be selected and
  // opens and closes it (lib/store.mjs), and while it is open its own tree, drawn as the main one is,
  // with a heading per deployment in a view of two or more. Its rows wait as any row does; the heading
  // says that one of them waits, open or closed.
  if (background !== null) {
    parts.push({ kind: "background", id: BACKGROUND_ID, open: background.open, count: background.count, waiting: background.waiting });
    for (const part of background.sections) drawn(part, true);
  }
  // The roster read failed and no answer has arrived yet: there is no machine to say it.
  // It is about no row above it: an empty row sets it apart when something stands there.
  if (state.remote.rosterFailure !== null) parts.push(...(parts.length ? [{ kind: "gap" }] : []), { kind: "own", words: ROSTER_FAILED }, { kind: "sentence", value: state.remote.rosterFailure });

  // The entry of this machine's deployment, when the view's primary is one: only it is ever
  // pending, withholds homes, or holds nothing after a failed read. A machine's panel has none.
  const status = panel?.deployment?.status ?? null;
  const local = panel !== null && !!panel.deployment;
  const counted = runtimeCounts(instances);
  // Every row of the workspace that waits, the Background section's too, open or closed (#1579).
  const waiting = instances.filter((row) => waitingClaim(row, { stale: stale(row) })).length;
  const withheld = Array.isArray(panel?.deployment?.withheld) ? panel.deployment.withheld.length : 0;
  // The machines of the view other than this one, each once, and whether a deployment of this
  // machine is in it: both read from the shared entries (`local`), never decided here.
  const away = [...new Set(deployments.filter((d) => d.local === false && text(d.machine)).map((d) => d.machine))];
  const machines = away.length, here = deployments.some((d) => d.local === true);
  // Whether a list stands in the sidebar: not for a deployment of this machine that was never
  // observed, nor for a machine that is not live and has no row kept. Each has only its reason.
  const observed = panel !== null && !gone && (local ? status === "observed" : live || instances.length > 0);
  return {
    panel, gone, instances, ordered, deployments, multi, parts, rows, filtering, stale, section, siblings, live, observed, folded,
    // What the selection stands on, in drawn order: the instances' rows and the Background heading.
    stops: parts.filter((part) => part.id !== undefined),
    placement, background,
    below: waitingRollup(instances, state.collapsed, state.open, { filtering, stale, section }),
    status,
    workspace: text(panel?.workspace?.name) ? panel.workspace.name : "",
    machines, here,
    // The one machine of a view that holds no deployment of this machine: a view of one deployment
    // has no heading, so the detail names it (detailOf).
    machine: !here && away.length === 1 ? away[0] : null,
    // The counts in the order they are drawn. `shared`: the word is the shared home's.
    counts: [
      ...Object.entries(counted).slice(0, 1).map(([word, n]) => ({ n, word, shared: true })),
      { n: waiting, word: waiting === 1 ? "needs input" : "need input", shared: false },
      ...Object.entries(counted).slice(1).map(([word, n]) => ({ n, word, shared: true })),
      { n: withheld, word: "withheld", shared: false },
    ].filter((count) => count.n > 0),
    readAt,
    // A deployment that is not live says so above the list, with why. Before the first answer
    // the list holds the TUI's own line instead: the shared sentence for that moment names an
    // installed CLI, and the TUI runs its own kernel.
    // `since`: an entry kept over a failed read carries the time of its last good read. An
    // unavailable entry carries only the time of the cycle that failed, which is no "since".
    notice: panel === null || gone || primary === null || live || status === "pending" ? null
      : { text: said.text, since: status === "observed" ? clockTime(panel.generatedAt) : null, reason: said.detail },
    // The note of the one deployment of a view that has no headings: above the list.
    note: !multi && text(primary?.note) ? primary.note : null,
    // Why no instance is listed. "none" is a statement about the deployment, so it is made only
    // of one that was read: a machine that is not live and has no row kept is not known to have
    // none (it is not `observed`), and its notice is all there is to say.
    // A Background heading is something listed: every instance in a closed section is no "nomatch".
    empty: status === "pending" ? "reading" : !observed ? null : !instances.length ? "none" : !parts.some((part) => part.id !== undefined) ? "nomatch" : null,
    // As wide as the widest word among all the rows of the list, so the column does not move
    // while the list scrolls.
    wordWidth: Math.min(WORD_MAX, rows.reduce((widest, { row }) => Math.max(widest, textWidth(displayLine(wordOf(row, state.ascii)) ?? "")), 0)),
  };
}

/** The TUI's own line for a roster read that failed before any answer arrived. */
export const ROSTER_FAILED = "Other machines were not read.";

/** The list as rows of the screen for a pane `cols` wide: every part on one row, a sentence on
 *  as many as it needs. An item is null (an empty row), an instance (`{ row, id, depth }`), the
 *  Background heading (`{ kind: "background", id: BACKGROUND_ID, open, count, waiting }`): the two
 *  kinds that can be selected, both with an `id`; `{ heading }`, `{ line }` (one row of a sentence,
 *  safe text), `{ own }` (the TUI's words) or `{ empty }` (why no instance is listed). `index`: the
 *  id of what can be selected to its place. */
function flatten(base, cols, ascii) {
  const items = [];
  const room = Math.max(1, cols - SENTENCE_INDENT - 1);
  // The line that says why no instance is listed, set apart from what follows it by an empty row.
  if (base.empty) items.push({ empty: base.empty }, ...(base.parts.length ? [null] : []));
  for (const part of base.parts) {
    if (part.kind === "gap") items.push(null);
    else if (part.kind === "row" || part.kind === "background") items.push(part);
    else if (part.kind === "heading") items.push({ heading: part });
    else if (part.kind === "own") items.push({ own: part.words });
    else for (const line of shownLines(part.value, room, SENTENCE_ROWS, { ascii })) items.push({ line });
  }
  return { items, index: new Map(items.flatMap((item, i) => (item?.id !== undefined ? [[item.id, i]] : []))) };
}

/** One answer is kept: a repaint, a resize and a key that changes nothing the roster is made
 *  from read it again without asking the shared home again (its grouping walks the whole roster
 *  for each row). The state's values are never changed in place, so their identity says whether
 *  they changed. The flattening for the last width asked is kept beside it. */
const MADE_FROM = ["entries", "remote", "memory", "notes", "rosterAt", "collecting", "ctxs", "open", "collapsed", "background", "cli", "home", "retiring", "ascii"];
let kept = null;
/** The roster of a state: the rows in drawn order and what the sidebar's title says, for a list pane
 *  `cols` wide. Only `items` and `index` depend on the width; `rows`, the instances in drawn
 *  order, and `stops`, those and the Background heading (what the selection stands on), do not. `at` stamps a machine's panel before any roster outcome was taken, which
 *  never shows; it is passed on. */
export function roster(state, at = new Date(0).toISOString(), cols = ANY_WIDTH) {
  const same = kept && MADE_FROM.every((name) => kept.state[name] === state[name]) && kept.state.filter.query === state.filter.query && kept.state.filter.soul === state.filter.soul;
  if (!same) kept = { state, base: build(state, at), flat: null };
  if (!kept.flat || kept.flat.cols !== cols || kept.flat.ascii !== state.ascii) kept.flat = { cols, ascii: state.ascii, ...flatten(kept.base, cols, state.ascii) };
  return { ...kept.base, items: kept.flat.items, index: kept.flat.index };
}

/** Whether a row has instances below it, and whether they are folded away. A filter shows every
 *  match whatever is collapsed, and leaves the collapse set as it is. */
export function disclosure(state, r, item) {
  if (!hasInstanceChildren(r.instances, item.row)) return null;
  return !r.filtering && state.collapsed.has(collapseKey(state.open, item.id)) ? "closed" : "open";
}

/** An instance's name as its row draws it: the shared `instanceDisplayName`, the Desktop's sidebar
 *  label (`oats-expert` is drawn "Oats expert"; a name of nothing but `-` as it is). The display
 *  filter is asked about the name first, as it came: a name it withholds is passed on unchanged, so
 *  shown() withholds it in the view, since the words could hide what made it unsafe (a `-` in a
 *  credential's URL becomes a space; a control character at an end is trimmed). */
const rowName = (name) => (displayLine(name) === DETAIL_WITHHELD ? name : instanceDisplayName(name) || name);
/** One row of the list: its mark, its name, the word its mark cannot say (or null), whether it
 *  waits, and on a folded row only, how many instances are folded away under it (`folded`) and how
 *  many of those wait (`below`). A row that is not folded says nothing of its children: they
 *  stand under it, indented. `selected` the selected row, `cursor` whether it carries `>`.
 *  The name is drawn as words (rowName): it is what the row shows and nothing else. The filter, the
 *  palette, the detail, the tabs, a confirmation and every change sent to the kernel keep the
 *  instance's name. */
function listRow(state, r, item) {
  const closed = disclosure(state, r, item) === "closed";
  return {
    id: item.id, name: rowName(item.row.instance), depth: item.depth, selected: item.id === state.selected,
    // The selected row keeps its reverse video while the list of workspaces has the focus, but not the
    // cursor: only the region with the focus draws `>`.
    cursor: item.id === state.selected && state.focus !== "workspaces",
    mark: markOf(item.row), color: rowColour(item.row), word: wordOf(item.row, state.ascii),
    waiting: waitingClaim(item.row, { stale: r.stale(item.row) }) !== null,
    folded: closed ? r.folded.get(item.id) ?? 0 : 0,
    below: closed ? r.below.get(item.id)?.length ?? 0 : 0,
  };
}

/** The Background section's heading as its row draws it (#1579): open or closed, how many rows the
 *  section holds (those a filter leaves), whether one of them waits (said by the needs-input tag,
 *  open or closed), and the selection, as an instance row has it. */
function backgroundRow(state, item) {
  return {
    kind: "background", id: item.id, open: item.open, count: item.count, waiting: item.waiting,
    selected: item.id === state.selected, cursor: item.id === state.selected && state.focus !== "workspaces",
  };
}

/** A text the TUI did not write, as the detail and the outcome line draw it, or null when it has
 *  nothing to show. Who made it is the shared home's to say: after the words originLead gives for
 *  `origin` when it names a speaker; as it is when the shared home vouches for it (`vouched`: it
 *  is a sentence of the shared home's own); else in quotation marks, naming nobody. A missing mark
 *  is never read as "the shared home wrote this".
 *  The filter is asked about the text alone, before anything is put around it, so the words in
 *  front are never why a text is shown. What it withholds goes to the view as it came, which
 *  draws the withheld word and nothing else. (The view asks again about the whole value: words in
 *  front never change the answer; a closing quotation mark can, for a text that ends in a
 *  secret's name and its sign, and that text is then withheld.) */
function spoken(value, origin, vouched) {
  const line = displayLine(value);
  if (line === null) return null;
  if (line === DETAIL_WITHHELD) return value;
  const lead = originLead(origin, TERMS);
  return lead !== null ? `${lead} ${line}` : vouched ? line : `"${line}"`;
}

/** A reason of the shared home's (a held row's, an act's), as `spoken` says it: its sentence is
 *  vouched for when it carries no mark. */
const reasonSpoken = (reason) => spoken(reason.sentence, reason.origin, reason.origin === undefined);

/** The TUI's own words around opening an agent's terminal (docs/tui.md, "Opening an agent").
 *  Each is a list of parts: `{ own }` is the TUI's, `{ shown }` text from outside (a name, a
 *  machine's name), drawn through the display filter on its own. `<id>` and `<home>` in the
 *  command are the TUI's placeholders: nothing of the row is in them. */
export const OPEN_WORDS = Object.freeze({
  failed: (name) => [{ shown: name }, { own: " could not be opened." }],
  link: (machine) => [{ own: "The connection to " }, { shown: machine }, { own: " ended." }],
  unknown: (name) => [{ own: "The viewer of " }, { shown: name }, { own: " ended without saying why." }],
  noTmux: (name) => [{ shown: name }, { own: " could not be opened: the terminal panel needs tmux 3.2 or later on this machine." }],
  notRunning: (name) => [{ shown: name }, { own: " is not running, so it has no terminal to open." }],
  stateUnknown: (name) => [{ own: "Whether " }, { shown: name }, { own: " runs is not known, so it is not opened." }],
});
/** The tabs' own words (docs/tui.md, "Tabs"): at the cap, how many are open and the leader's key
 *  that closes the shown one. */
const LEADER_CLOSE = LEADER.find((entry) => entry.does === "close-terminal").keys[0];
export const TAB_WORDS = Object.freeze({
  full: (limit, leader) => [{ own: `${limit} terminals are open; close one with ` }, { own: `${leader} ${keyLabel(LEADER_CLOSE)}`, whole: true }, { own: "." }],
});
/** The line of a leader whose key came in its own read (docs/tui.md, "The leader"): dropped, and
 *  why. */
export const LEADER_WORDS = Object.freeze({
  merged: (leader) => [{ own: leader, whole: true }, { own: " and the next key came in one read, so nothing ran: press them one after the other." }],
});
/** The lines of a split that is not made (docs/tui.md, "Splits"): a second split, and a panel too
 *  small for two groups (`min` views/split.mjs SPLIT_MIN). */
export const SPLIT_WORDS = Object.freeze({
  twice: () => [{ own: "The panel has two groups already." }],
  small: (dir, min) => [{ own: dir === "right" ? `No room to split side by side: each group needs ${min.cols} columns.` : `No room to split one above the other: each group needs ${min.rows} rows.` }],
});
/** The scroll keys the shown terminal's viewer takes, `{ shift, prefix }`, so the cheat sheet names
 *  them (docs/tui.md, "Tabs"): as the tab's host's kernel says, this machine's for a tab of this
 *  machine, the group's roster probe for another's (`rows`, the roster's instances, find the tab's
 *  row and so its group). Ctrl+B [ is not named with the leader Ctrl+B, which the TUI takes before
 *  the viewer reads it. No terminal shown, or a tab whose row is gone: neither. */
export function scrollKeys(state, rows, at) {
  const t = state.terminal;
  if (!t) return NO_SCROLL_KEYS;
  let keys = localScrollKeys(state.cli);
  if (t.routed) {
    const row = rows.find((r) => instanceId(r) === t.id);
    const group = row ? heldDeployments(heldOf(state, at)).find((d) => d.id === row.deployment?.id)?.group : undefined;
    keys = group ? hostScrollKeys(state.cli, group) : NO_SCROLL_KEYS;
  }
  return keys.prefix && state.leaderKey === "ctrl+b" ? Object.freeze({ ...keys, prefix: false }) : keys;
}
const NO_SCROLL_KEYS = Object.freeze({ shift: false, prefix: false });
/** The groups of the panel as the frame draws them (docs/tui.md, "Splits"): one, or two with a
 *  split, each `{ tabs, shown, waiting }`: its tabs in the strip's order (`{ id, name, machine,
 *  routed, shown, activity }`, `machine` only for another machine's), its shown tab's id, or null
 *  for an empty group, and what its waiting row says (waitingOf). */
function groupsOf(state, r, now) {
  return Array.from({ length: state.split === null ? 1 : 2 }, (_, g) => {
    const shown = g === state.group ? state.terminal?.id ?? null : state.aside;
    const tabs = state.tabs.filter((tab) => tab.group === g).map((tab) => ({ id: tab.id, name: tab.name, machine: tab.routed ? tab.machine : null, routed: tab.routed, shown: tab.id === shown, activity: tab.activity }));
    return { tabs, shown, waiting: waitingOf(r, shown, now) };
  });
}
/** What a claim with no message waits on, in the TUI's words, by its reason (docs/tui.md, "Tabs"). */
const WAITING_WORDS = Object.freeze({ permission: "waiting on a permission prompt", question: "asked you a question", attention: "asked for your attention" });
const WAITING_UNSAID = "waiting for your input";
/** The waiting row of a group whose shown agent is `id` (views/frame.mjs waitingRows): the
 *  agent's live claim, read through the shared gate as the list's `!` mark is, as `{ message, words,
 *  age }`: its message (agent text) or null, the TUI's words for a claim with none, and how long
 *  it has waited at `now`. A message the display filter leaves nothing of (only spaces) is none.
 *  Null for an empty group and an agent with no live claim. */
function waitingOf(r, id, now) {
  const row = id === null ? null : r.instances.find((each) => instanceId(each) === id) ?? null;
  const claim = row === null ? null : waitingClaim(row, { stale: r.stale(row) });
  if (claim === null) return null;
  const message = text(claim.message) && displayLine(claim.message) !== null ? claim.message : null;
  const words = Object.hasOwn(WAITING_WORDS, claim.reason ?? "") ? WAITING_WORDS[claim.reason] : WAITING_UNSAID;
  return Object.freeze({ message, words, age: waitedText(claim.since, now) });
}
/** A command in a line of the TUI's own: whole, never broken over two rows. */
const command = (text) => Object.freeze({ own: `\`${text}\``, whole: true });
/** A sentence from outside (a reason of the shared home's, the preflight table's), as a text
 *  under the line: drawn as the detail draws a reason, wrapped on the reason's rows, never as one
 *  unbroken part (a part is a name). */
const outside = (value) => (value === null ? [] : [value]);

/** Whether a row is of another machine: the shared home names its server on it. */
const elsewhere = (row) => typeof row.server === "string" && row.server !== "";

/** Whether `row`'s terminal can be opened from here, and what Enter does: `acts` is the row's
 *  instanceActs answer (computed once per selected row, for the detail too).
 *    { open: true, id, name, machine, target, routed }  the kernel's viewer can be started:
 *        `target` is what the shared sessionAttachArgv and prepareRemoteTerm take, `routed` true
 *        for a row of another machine (its preflight runs first)
 *    { open: false, said: { said, under } }             opens nothing, and this says why
 *  Whether a row can be opened is the shared openAct's, switched on its reason's code, never on a
 *  sentence. A row on a session provider is never opened, from the list, the palette, the steps or a
 *  workspace's remembered tabs (they all ask here); its reason's link is printed under its sentence. The viewer is started with no key of its own (the TUI takes the back key before the
 *  pane sees it), so a kernel or a host of any version is opened alike. */
export function openDecision(state, row, acts) {
  const name = row.instance, id = instanceId(row);
  const machine = elsewhere(row) ? row.deployment?.machine ?? row.server : null;
  const no = (said, under = []) => ({ open: false, said: { said, under } });
  const act = openAct(row);
  if (act === null) {
    const held = acts.blocked ?? acts.limited;
    return no([], outside(reasonSpoken(held)));
  }
  if (!act.enabled) {
    if (act.reason.code === "not-running") return no(OPEN_WORDS.notRunning(name));
    if (act.reason.code === "state-unknown") return no(OPEN_WORDS.stateUnknown(name));
    // A row on a session provider (code `no-terminal`) has no terminal: the shared home's sentence says where
    // the agent runs, and under it the link the provider offers, as the kernel's row gave it (its label and
    // its url, one text from outside), for the person to open themselves. Nothing is attached or started.
    const link = act.reason.link ? spoken(`${act.reason.link.label}: ${act.reason.link.url}`, "kernel", false) : null;
    return no([], [...outside(reasonSpoken(act.reason)), ...outside(link)]);
  }
  if (!elsewhere(row)) return { open: true, id, name, machine, target: { home: row.home }, routed: false };
  return { open: true, id, name, machine, target: { serverId: row.server, instance: row.instance, home: row.home }, routed: true };
}

/** The line after a terminal closed by itself, or null when the TUI says nothing of its own: the
 *  viewer ended with status 0 (the list shows the agent as the kernel now reports it), or the
 *  person closed it (`asked`: c, or Enter on another row). `status` is what the pane's shell
 *  wrote of the viewer's exit (lib/panel.mjs), null when it wrote none; the shared attachExit reads
 *  it, as for a viewer started with no key, and the TUI compares no number. What the viewer printed
 *  on stderr stands under a failure, once, as one text in quotation marks naming nobody: OATS, tmux
 *  and ssh all print there, and nothing is compared with it. `refused` is the panel's own refusal
 *  when no viewer was started at all: "tmux" (no tmux here, or one too old), or "start" (the
 *  panel's server or window was not made; `stderr` is then what tmux said). */
export function returnedLine({ name, machine, routed }, status, stderr, { asked = false, refused = null } = {}) {
  if (asked) return null;
  if (refused === "tmux") return { said: OPEN_WORDS.noTmux(name), under: [] };
  if (refused !== null) status = 1;
  const word = attachExit(status, { keyed: false, routed });
  if (word === "ended") return null;
  if (word === "unknown") return { said: OPEN_WORDS.unknown(name), under: [] };
  const line = displayLine(stderr);
  const under = line === null ? [] : [line === DETAIL_WITHHELD ? DETAIL_WITHHELD : `"${line}"`];
  return { said: word === "link" ? OPEN_WORDS.link(machine) : OPEN_WORDS.failed(name), under };
}

/** The line after a preflight that failed, or null when there is nothing to say: the person's own
 *  Esc, or a row that went away (E_TERM_CONTEXT_CHANGED). Else the shared table's sentence, and
 *  under it what the kernel said, when it said something (kernelLines). */
export function preflightLine({ machine }, error) {
  const failure = preflightFailure(error, machine);
  if (failure.code === "E_TERM_CONTEXT_CHANGED") return null;
  return { said: [], under: [...outside(failure.sentence), ...(failure.said === null ? [] : kernelLines(failure.said.message, failure.said.fix, TERMS))] };
}

/** The row's own text (its `runtimeError`), in the form that says who made it (see detailOf), or
 *  null. `acts` is the row's instanceActs answer: a reason of it that carries no `origin` and is
 *  this very text vouches for it. */
function rowText(row, acts) {
  const vouched = [acts.blocked, acts.limited, ...acts.acts.map((act) => act.reason)].some((reason) => reason && reason.origin === undefined && reason.sentence === row.runtimeError);
  return spoken(row.runtimeError, row.runtimeErrorOrigin, vouched);
}

/** The facts of one instance, a label and a value per line; a fact that is absent is left out.
 *  `form`: `line` (one row), `wrap` (a sentence, on as many rows as it needs), `end` (read from
 *  its end: a path). A fact with no label continues the one above it. Every value is text the
 *  TUI did not write, or holds some: the view draws all of them through shown(). `now` is the
 *  time of the paint, so the waited time is right whenever the screen is drawn. */
function detailOf(state, r, item, now, acts) {
  const row = item.row, facts = [];
  const add = (label, value, form = "line") => { if (text(value)) facts.push({ label, value, form }); };
  add("soul", row.agent);
  // Which machine the instance is on: in a view of two or more deployments, and in one whose only
  // deployment is another machine's, where no heading and no row of the list of workspaces names it.
  if (r.multi || r.machine !== null) add("machine", row.deployment?.machine);
  if (r.multi) {
    // When that deployment is not live, the whole sentence that says why: a heading has room for
    // the short reason only.
    const of = r.deployments.find((d) => d.id === row.deployment?.id);
    const said = of ? deploymentState(of) : null;
    if (said && said.key !== "live") add("", said.detail, "wrap");
  }
  add("state", detailState(row, state.ascii));
  const held = acts.blocked ?? acts.limited;
  // The row's own text stands under its state, in the form that says who made it. Who made it is
  // the shared home's to say, in two ways, and the TUI writes no word and no sentence of its own
  // for either: the row's mark, which originLead turns into the words that go before the text;
  // or a reason of the row that carries no `origin`, which is a sentence the shared home wrote
  // itself, when that sentence is this very text (compared as given). A text with neither is
  // vouched for by nobody: it stands in quotation marks and names no one. A missing mark is
  // never read as "the shared home wrote this".
  // The filter is asked about the text alone, before anything is put around it, so the words in
  // front are never why a text is shown. What it withholds goes to the view as it came, which
  // draws the withheld word and nothing else. (The view asks again about the whole value: words
  // in front never change the answer; a closing quotation mark can, for a text that ends in a
  // secret's name and its sign, and that text is then withheld.)
  add("", rowText(row, acts), "wrap");
  // What holds the row, when that is not the row's text, said as `spoken` says it. A held home's
  // reason (code `held`) is never the row's text: the shared home's sentence, or a failed retire's
  // words of the kernel's (#1247), whose speaker `spoken` names. Any other reason is the row's text
  // when it carries an `origin`, or when its sentence is that text: either stands once, under the state.
  const own = held && (held.code === "held" || (held.origin === undefined && held.sentence !== row.runtimeError));
  if (own) add("held", reasonSpoken(held), "wrap");
  const claim = waitingClaim(row, { stale: r.stale(row) });
  if (claim) {
    add("needs", `${waitingLabel(claim)}, ${waitedText(claim.since, now)}`);
    if (text(claim.message)) add("", `the agent: "${claim.message.trim()}"`, "wrap");
  }
  const under = disclosure(state, r, item) === "closed" ? r.below.get(item.id) : null;
  if (under?.length) add("below", waitingBelowText(under), "wrap");
  add("harness", `${[row.harness, row.model].filter(text).join(", ")}${text(row.model) && text(row.modelFrom) ? ` (${row.modelFrom})` : ""}`);
  add("work", [row.work, row.branch].filter(text).join(", "));
  add("team", row.team);
  add("parent", [row.parentInstance, siblingText(r.siblings.get(item.id))].filter(text).join(", "));
  if (text(row.startedAt)) add("started", waitingClock(row.startedAt, now));
  add("home", row.home, "end");
  return { title: row.instance, facts };
}

/** The heading of the rows of this computer's deployments list that this run does not serve: the TUI's own. */
export const OFFERED_SECTION = "On this machine, not opened";

/** The words of this computer's deployments list (awebai/oats#1390) where they are a line of their
 *  own: the add of the deployment the run started in, when it failed (the line under the sidebar's title,
 *  once; the kernel's message says what to do, and is shown as it came), and a change to the list
 *  still running as the TUI leaves. */
export const LIST_WORDS = Object.freeze({
  notAdded: (message) => Object.freeze([{ own: "This deployment was not added to this computer's list: " }, { shown: message }]),
  /** An add or a remove still running as the TUI leaves: one line, after the screen is left. */
  leaving: "oats: a change to this computer's list of deployments is still running; `oats deployments` shows the list.",
});

/** The lines of the list of workspaces (docs/tui.md, "The list of workspaces"): the leader's Up or
 *  Down with no other row to open (the Desktop's words), and a row picked there that is not a
 *  deployment any more. */
export const WORKSPACE_WORDS = Object.freeze({
  noOther: () => [{ own: "No other workspace to show." }],
  refused: (name) => [{ shown: name }, { own: ": not an OATS deployment any more." }],
});
/** The switcher's choices with no filter, in its order (workspaceList's rows are their keys). */
export const listChoices = (state, at = new Date(0).toISOString()) => switcherOf(state, at, "").made.items.filter((item) => item.key !== undefined);
/** The switcher's choice of key `key`, with no filter, or null. */
export const listChoice = (state, key, at) => listChoices(state, at).find((item) => item.key === key) ?? null;

/** The help's `keys` on macOS (views/help.mjs chordFamilyLines): no family, no file's note. */
const MAC_KEYS = Object.freeze({ family: null, label: null, note: null, mac: true });
/** What the switcher says above its rows, as views/switcher.mjs leadRows reads it. */
const leadOf = (state) => ({ said: state.switcher.line, failure: state.listed.failure?.message ?? null, removing: state.switcher.removing !== null });
/** How many rows stand above the switcher's choices in an area `cols` wide (the switcher's is the
 *  whole width): what happened (`line`), that the last read of the list failed, and a Remove
 *  asked, as views/switcher.mjs leadRows draws them. The window of the choices is that much
 *  shorter, so none is hidden for them. */
export function switcherLead(state, cols) {
  return leadRows(leadOf(state), Number.isInteger(cols) && cols > 0 ? cols : 80, { ascii: state.ascii }).length;
}

/** The word an indicator line says of a deployment of a workspace in the switcher, or null for a live
 *  one: "not opened" for a deployment of this computer's list that this run does not serve (the TUI's
 *  own), else the shared word for its state (roster-sections.mjs deploymentState: not observed, not
 *  reached, stale, remembered). */
export const NOT_OPENED = "not opened";
function indicatorState(info) {
  if (info.listed) return NOT_OPENED;
  const said = deploymentState(info);
  return said.key === "live" ? null : said.text;
}

/** The switcher's rows for a state, top to bottom: the workspaces, each a choice followed by one
 *  indicator line per deployment of it; then the views matched to no workspace under the shared
 *  heading; then the rows of this computer's deployments list that this run does not serve and that
 *  no workspace took, in the kernel's order, under the TUI's own.
 *  A workspace is what the shared rule (panel-views.mjs listedViews, buildViews underneath) makes of
 *  the deployments this run serves, the machines' groups and the listed deployments whose identity a
 *  read learned (`state.identities`, lib/main.mjs): a listed deployment that reports the same
 *  workspace as another is in its row. A served deployment's id and a row's path are both canonical,
 *  so a deployment opened in this run is never offered again.
 *  An item is `{ heading, shared }`; `{ indicator }`, a line under a workspace (its deployment's
 *  machine label, with a path tail where the shared label adds one, then its state word when it is
 *  not live: indicatorState), never a choice; or a choice: `{ key, label, open, primary, join, opens }`
 *  for a workspace (`primary` the deployment Enter opens when every local one is served; `join` the
 *  listed deployments Enter opens first, and `opens` the deployments it may then open, in order),
 *  `{ key, label, place, notLiveText, open, primary }` for a view matched to no workspace, and
 *  `{ key, label, place, path, state, refused }` for a row of the list (`state` the kernel's:
 *  views/switcher.mjs says a stale one in words; `place` why no workspace took it, when a read said, then its path: the reason first, so a narrow row
 *  cuts the path and keeps it).
 *  `keys` are the choices in order; `selected` is the key the selection stands on (the first choice
 *  when the state's own is not listed). */
export const switcher = (state, at = new Date(0).toISOString()) => switcherOf(state, at, state.switcher.query).made;
/** The switcher's rows for `query` (`made`), and of each workspace's key whether some instance of it
 *  needs input (`waits`), which the list of workspaces says (workspaceList). */
function switcherOf(state, at, query) {
  const held = heldOf(state, at);
  const unserved = state.listed.rows.filter((row) => !state.ctxs.includes(row.path));
  // Only a row the kernel says is a deployment is matched: a stale one (missing, not one any more) says so instead.
  const views = listedViews(held, unserved.filter((row) => row.state === "ok"), TERMS);
  const choices = workspaceChoices(held, TERMS, views), rows = workspaceChoiceRows(choices);
  // Whether some instance of a workspace needs input: what this run observes of it alone, the shared
  // choice's `waiting` (its served deployments' reads; unknown or stale is not).
  const waits = new Map(choices.map((choice) => [`view\u0000${choice.id}`, choice.waiting === true]));
  const viewOf = (id) => views.views.find((v) => v.id === id);
  const openView = state.open === null ? null : views.views.find((v) => v.id === state.open || v.deployments.includes(state.open))?.id ?? null;
  const items = [];
  for (const row of rows.filter((each) => !each.unattached)) {
    // This machine's deployments first (the served, then the listed), then the other machines', each in the shared order.
    const all = viewOf(row.id).deployments.map((id) => views.infos.get(id)).filter(Boolean);
    const infos = [...all.filter((info) => info.local), ...all.filter((info) => !info.local)], view = viewOf(row.id);
    const labels = machineLabels(infos, TERMS);
    const lines = infos.map((info) => [labels.get(info.id), indicatorState(info)].filter(Boolean).join(" · "));
    if (!choiceMatches({ label: row.label, place: lines.join(" ") }, query)) continue;
    const join = infos.filter((info) => info.listed).map((info) => info.id);
    items.push({ key: `view\u0000${row.id}`, label: row.label, open: row.id === openView, primary: view.primary, join,
      opens: infos.map((info) => info.id) });
    for (const line of lines) items.push({ indicator: line });
  }
  const unmatched = rows.filter((row) => row.unattached && choiceMatches(row, query)).map((row) => ({
    key: `view\u0000${row.id}`, label: row.label, place: row.place, notLiveText: row.notLiveText, open: row.id === openView, primary: viewOf(row.id)?.primary ?? null,
  }));
  const why = new Map(views.unmatched.map((info) => [info.id, info.short]));
  const taken = new Set([...views.infos.keys()]);
  const offered = unserved.filter((row) => !taken.has(row.path))
    .map(({ path, name, state: listedState }) => ({
      key: `path\u0000${path}`, label: name, place: [why.get(path), shortPath(path, { home: state.home })].filter(Boolean).join(" · "), path, state: listedState, refused: state.switcher.refused === path,
    }))
    .filter((item) => choiceMatches(item, query));
  items.push(
    ...(unmatched.length ? [{ heading: UNMATCHED_SECTION, shared: true }, ...unmatched] : []),
    ...(offered.length ? [{ heading: OFFERED_SECTION, shared: false }, ...offered] : []),
  );
  const keys = items.filter((item) => item.key !== undefined).map((item) => item.key);
  const total = rows.length + unserved.filter((row) => !taken.has(row.path)).length;
  const made = {
    items, keys, selected: keys.includes(state.switcher.selected) ? state.switcher.selected : keys[0] ?? null,
    empty: keys.length ? null : total ? "nomatch" : "none",
  };
  return { made, waits };
}
/** THE LIST OF WORKSPACES (docs/tui.md, "The list of workspaces"): one row per workspace the switcher
 *  offers, by its name, whatever machines it is on, in the switcher's order, at the top of the
 *  sidebar. A workspace only this machine's deployments not opened make is not one of them, nor a
 *  view with nothing to open, nor a row of this computer's list: the switcher keeps those (`w` `w`).
 *  `lines`: a row `{ key, label, current, waiting }`: `current` the open workspace's row; `waiting`
 *  whether some instance of it needs input, as far as this run observes it (an unknown never says
 *  so). `rows`: the rows as `{ key, openable }`, for workspaceStep (every row opens). `current`: the
 *  open row's key, or null. Kept while what it is made from (LIST_MADE_FROM) is the same: every
 *  frame and every key asks for it, and the shared home walks every machine to make it, so it is
 *  not asked again for a key or a paint that changed none of that (as `roster` is kept). */
const LIST_MADE_FROM = ["entries", "remote", "memory", "notes", "rosterAt", "collecting", "ctxs", "open", "cli", "home", "identities", "listed"];
let listKept = null;
export function workspaceList(state, at) {
  if (listKept !== null && LIST_MADE_FROM.every((name) => listKept.state[name] === state[name])) return listKept.list;
  const lines = [], { made, waits } = switcherOf(state, at, "");
  for (const item of made.items) {
    if (item.key === undefined || item.path !== undefined) continue;
    const notOpened = item.join?.length > 0 && item.join.length === item.opens.length;
    const opens = item.join?.length > 0 || item.primary !== null;
    if (notOpened || !opens) continue;
    lines.push(Object.freeze({ key: item.key, label: item.label, current: item.open === true, waiting: waits.get(item.key) === true }));
  }
  const list = Object.freeze({ lines: Object.freeze(lines), rows: Object.freeze(lines.map(({ key }) => Object.freeze({ key, openable: true }))), current: lines.find((line) => line.current)?.key ?? null });
  listKept = { state, list };
  return list;
}
/** The most lines the list stands on; more are windowed, and the last line says how many are not
 *  shown (`+N`), with the dot when an instance of one of them needs input. */
export const LIST_LINES = 5;
/** How many rows stand at the top of the sidebar (views/frame.mjs layout's `list`): the list's,
 *  LIST_LINES at most, while a workspace is open and the switcher is not shown; else the title's
 *  one. */
export function listRowsOf(state, at) {
  const under = state.view === "help" || state.view === "act" ? state.back : state.view;
  const list = listModel(state, under, at);
  return list === null ? 1 : list.lines.length + (list.more > 0 ? 1 : 0);
}
/** The list as the sidebar draws it (views/workspaces.mjs): its lines windowed around the cursor
 *  while the list has the focus, else around the open workspace's row; `more` how many are not
 *  shown, and `moreWaiting` whether one of those is waiting; `focused`; `cursor` the cursor's row
 *  key, null without the focus. Null while nothing is listed (no workspace open, or the switcher
 *  shown): the title stands there. */
function listModel(state, under, at) {
  if (under === "switcher" || state.open === null) return null;
  const list = workspaceList(state, at);
  if (!list.lines.length) return null;
  const focused = state.view === "instances" && state.focus === "workspaces";
  const cursor = focused ? (list.rows.some((row) => row.key === state.workspaceCursor) ? state.workspaceCursor : list.current) : null;
  return { ...listWindow(list.lines, cursor ?? list.current), focused, cursor };
}
/** The lines the list draws, windowed around `keep` (the focused row, else the open one): all of
 *  them when they fit, else LIST_LINES - 1 of them, and `more`, how many are not shown, and
 *  `moreWaiting`, whether one of those is `waiting`. */
export function listWindow(lines, keep) {
  if (lines.length <= LIST_LINES) return { lines, more: 0, moreWaiting: false };
  const height = LIST_LINES - 1, at = Math.max(0, lines.findIndex((line) => line.key === keep));
  const top = Math.min(Math.max(0, at - Math.floor(height / 2)), lines.length - height);
  const shown = lines.slice(top, top + height);
  const moreWaiting = lines.some((line, i) => (i < top || i >= top + height) && line.waiting);
  return { lines: shown, more: lines.length - shown.length, moreWaiting };
}
/** The window of the switcher's `items` in a pane `height` rows tall, from `top`, that holds the choice
 *  `key` and, while they fit, the indicator lines under it (scroll.mjs windowOf, asked to keep the last
 *  of them and then the choice). No key (-1 kept): the window as `top` gives it. */
export function switcherWindow(items, key, { top, height }) {
  const at = key === null ? -1 : items.findIndex((item) => item.key === key);
  let last = at;
  while (last >= 0 && items[last + 1]?.indicator !== undefined) last++;
  const after = windowOf({ top, count: items.length, height, keep: last });
  return windowOf({ top: after.top, count: items.length, height, keep: at });
}

/** The palette's views and commands, each a row's label and the action it runs. */
const PALETTE_VIEWS = Object.freeze([["instances", "Instances"], ["souls", "Souls"], ["capabilities", "Capabilities"]]);
const PALETTE_COMMANDS = Object.freeze([["spawn", "Spawn an agent"], ["workspaces", "Workspaces"], ["refresh", "Refresh"], ["help", "Help"]]);
const PALETTE_SPLIT = Object.freeze({
  one: Object.freeze([["split-right", "Split right"], ["split-down", "Split down"]]),
  shown: Object.freeze([["tab-move", "Move tab to the other group"]]),
  empty: Object.freeze([["group-close", "Close the empty group"]]),
});
const PALETTE_ACTS = Object.freeze({ stop: "Stop", restart: "Restart", retire: "Retire", start: "Start" });

/** Which way each of the palette's own keys (its `does`, lib/actions.mjs paletteKeys) moves the
 *  selection among the palette's runs: to the next, or to the one before. */
const PALETTE_STEPS = Object.freeze({ "palette-next-group": 1, "palette-previous-group": -1 });

/** THE PALETTE'S ROWS (docs/tui.md, "The palette"), in this order: the instances that can be
 *  opened, grouped and ordered as the sidebar's tree but by recency (the shared rosterSections
 *  with `lastFocus`, the Desktop's palette's: the group, the cluster, the root and the child opened
 *  most recently in this run first, then the shared order; one section per deployment where the
 *  view has several, as the sidebar's), each group led by a row of its label (`kind: "group"`: its
 *  name, the deployment's before it where there are several, never selected), then the souls of
 *  the open workspace once its catalog was read, its capabilities once theirs was, the views, the
 *  acts the palette's instance offers (the open terminal's, when the palette came from its focus;
 *  else the selected one) and, once the catalog lists its soul, another of that soul, then
 *  spawning an agent, workspaces, refresh and help, and the split's that apply. With a query, an
 *  instance group keeps the rows the Desktop's subsequence score matches, in its own order, and a
 *  group with none has no label row; each kind after them keeps its matches the best first (a
 *  prefix first), a tie in that order. A row: `{ key, kind, label, does?, id?, name?, machine?, mark?, sibling?, capability?, source? }`.
 *  `runs`: the keys of the rows that can be selected, run by run (each instance group, then each
 *  kind), which the palette's own keys move between (paletteStep). `selected` is the key the
 *  selection stands on (the first row that can be selected when the palette's own is not listed). */
export function paletteItems(state, at = new Date(0).toISOString()) {
  const p = state.palette;
  if (p === null) return { items: [], runs: [], selected: null };
  const query = p.query.trim();
  // An instance group keeps its order under a query; a kind is ranked by the score.
  const matched = (item) => query === "" || subsequenceScore(item.text, query) !== null;
  const ranked = (group) => (query === "" ? group
    : group.map((item, i) => ({ item, i, score: subsequenceScore(item.text, query) })).filter((each) => each.score !== null).sort((a, b) => a.score - b.score || a.i - b.i).map(({ item }) => item));
  const runs = [];
  if (state.open !== null) {
    const r = roster(state, at);
    const openable = r.instances.filter((row) => openDecision(state, row, instanceActs(row)).open);
    // The record of focus the shared order reads: larger is more recent, `recent` is the latest first.
    const recent = recentOf(state, at), lastFocus = new Map(recent.map((id, i) => [id, recent.length - i]));
    const item = (row) => {
      const machine = elsewhere(row) ? row.deployment?.machine ?? row.server : null;
      // `sibling`: the shared words for its siblings, or null; never part of what a query matches.
      return {
        key: `instance\u0000${instanceId(row)}`, kind: "instance", label: row.instance, id: instanceId(row), name: row.instance, machine, mark: markOf(row),
        sibling: siblingText(r.siblings.get(instanceId(row))), text: `${row.instance} ${machine ?? ""}`,
      };
    };
    for (const section of rosterSections(r.instances, openable, r.deployments, TERMS, { lastFocus, pins: pinsListed(state) })) for (const group of section.groups) {
      const rows = group.clusters.flatMap((cluster) => cluster.instances).map(item).filter(matched);
      if (!rows.length) continue;
      // A group is named, and kept apart, by its deployment where there are several (the Desktop's palette.mjs).
      const key = section.deployment ? `${section.deployment.id}|${group.key}` : group.key;
      runs.push([{ key: `group\u0000${key}`, kind: "group", label: section.deployment ? `${section.label} · ${group.label}` : group.label }, ...rows]);
    }
  }
  const kinds = [];
  // The souls of the open workspace, once its catalog was read (the Souls view opened): choosing
  // one shows the Souls view with it selected. A palette never reads the catalog.
  kinds.push(soulsOf(state).all.map((row) => ({ key: `soul\u0000${row.name}`, kind: "soul", label: row.name, name: row.name, text: row.name })));
  // The capabilities of the open workspace, once its catalog was read (the Capabilities view opened):
  // choosing one shows that view with it selected. Each says where it comes from (a package's and a
  // member's may share a name).
  const c = capabilitiesOf(state), names = memberNames(c.status);
  kinds.push(c.all.map((row) => {
    const capability = capabilityKey(row, names);
    return { key: `capability\u0000${capability}`, kind: "capability", label: row.name, name: row.name, capability, source: capabilitySource(row, names).label, text: row.name };
  }));
  kinds.push(PALETTE_VIEWS.map(([does, label]) => ({ key: `view\u0000${does}`, kind: "view", label, does, text: label })));
  const id = p.from === "terminal" && state.terminal !== null ? state.terminal.id : state.selected;
  const row = id === null || state.open === null ? null : roster(state, at).instances.find((each) => instanceId(each) === id) ?? null;
  if (row !== null && state.opening === null) {
    const acts = instanceActs(row);
    const another = !elsewhere(row) && state.ctxs.includes(state.open) ? soulOfAgent(state, state.open, row.agent) : null;
    kinds.push([
      ...ACT_VERBS.filter((verb) => actDecision(state, row, acts, verb).open)
        .map((verb) => ({ key: `act\u0000${verb}`, kind: "act", label: PALETTE_ACTS[verb], does: verb, id: instanceId(row), name: row.instance, text: `${PALETTE_ACTS[verb]} ${row.instance}` })),
      // Another of its soul (N), once the catalog lists that soul: the row names the soul.
      ...(another ? [{ key: "act\u0000spawn-another", kind: "act", label: "Spawn another", does: "spawn-another", id: instanceId(row), name: another.name, text: `Spawn another ${another.name}` }] : []),
    ]);
  }
  // The split's, after them, where each applies (docs/tui.md, "Splits"): a split while there is one
  // group, and with two the move of the shown tab, or the close of the focused group while it is
  // empty. A split there is no room for says so when it is run.
  const splitting = state.tabs.length > 0 && state.opening === null && !state.tabs.some((tab) => tab.status === "starting");
  const SPLIT = splitting ? (state.split === null ? PALETTE_SPLIT.one : state.terminal !== null ? PALETTE_SPLIT.shown : PALETTE_SPLIT.empty) : [];
  kinds.push([...PALETTE_COMMANDS, ...SPLIT].map(([does, label]) => ({ key: `command\u0000${does}`, kind: "command", label, does, text: label })));
  for (const kind of kinds) { const rows = ranked(kind); if (rows.length) runs.push(rows); }
  const items = runs.flat(), selectable = items.filter((each) => each.kind !== "group"), instances = selectable.filter((each) => each.kind === "instance");
  // With nothing chosen yet, the first row that can be selected; but in the palette as it opens (no
  // query), when that is the shown tab's instance (the most recent), the instance shown before it
  // (the second of this workspace's recency, wherever its group puts it), else the second instance:
  // the palette and Enter go back to the terminal before it, as the Desktop's recent group did.
  const before = instances.find((each) => each.id === recentOf(state, at)[1]) ?? instances[1];
  const first = p.query === "" && instances.length > 1 && selectable[0] === instances[0] && instances[0].id === state.terminal?.id ? before : selectable[0];
  return {
    items, runs: runs.map((run) => run.filter((each) => each.kind !== "group").map((each) => each.key)),
    selected: selectable.some((each) => each.key === p.selected) ? p.selected : first?.key ?? null,
  };
}
/** Where the palette's own key `does` (lib/actions.mjs paletteKeys) takes the selection of `list`
 *  (paletteItems): the first row of the next run, or of the one before, wrapping past either end;
 *  with one run, its first row. Null with no row, or for a `does` that is not the palette's. */
export function paletteStep(list, does) {
  const step = PALETTE_STEPS[does], n = list.runs.length;
  if (step === undefined || n === 0) return null;
  const at = list.runs.findIndex((run) => run.includes(list.selected));
  return list.runs[(((at < 0 ? 0 : at + step) % n) + n) % n][0];
}
/** The palette as the view draws it, in a body `page` rows tall: its query on the first row, and
 *  under it the window of its rows that holds the selection (whose last row says what is cut off,
 *  when something is: scroll.mjs windowOf keeps it). */
function paletteView(state, page, at) {
  const list = paletteItems(state, at), height = Math.max(1, page - 1);
  const selected = list.items.findIndex((item) => item.key === list.selected);
  const win = windowOf({ top: 0, count: list.items.length, height, keep: selected });
  return {
    query: state.palette.query, from: state.palette.from,
    rows: list.items.slice(win.top, win.top + win.size).map((item) => ({ ...item, selected: item.key === list.selected })),
    above: win.above, below: win.below, empty: list.items.length === 0,
  };
}

/** The rows the switcher's window has in an area `body` rows tall and `cols` wide: the lines above
 *  the choices take theirs (switcherLead), and the filter field one while it is typed or kept
 *  (views/frame.mjs). */
export const switcherHeight = (state, body, cols) => Math.max(1, body - switcherLead(state, cols) - (state.switcher.editing || state.switcher.query ? 1 : 0));

/** What the views draw for a state. For the Instances view, in a list pane `page` rows tall and
 *  `cols` wide: the title's facts, the rows of the window with their marks, and the selected
 *  instance's detail; the Souls and the Capabilities views' lists in the same pane, also under the
 *  help, which leaves the sidebar beside it (views/frame.mjs). For the switcher, the palette and
 *  the spawn prompt, in an area `body` rows tall (`page` when none is given): the window of their
 *  rows; `area` is the main area's width (`cols` when none is given), which the lines above the
 *  switcher's choices wrap to (views/frame.mjs mainArea). Only the rows in the pane are worked out. */
export function model(state, { page, body = page, now, at, cols, area = cols }) {
  const r = roster(state, at, cols);
  // The view under the help, or under a confirmation, decides what the sidebar says.
  const under = state.view === "help" || state.view === "act" ? state.back : state.view;
  const common = {
    view: state.view, focus: state.focus, ascii: state.ascii, actions: state.actions,
    // The filter of the view shown: the Souls view has one of its own.
    filter: state.view === "souls" ? state.souls.filter : state.view === "capabilities" ? state.capabilities.filter : state.filter,
    workspace: r.workspace, machines: r.machines, here: r.here, machine: r.machine, counts: r.counts, readAt: r.readAt, notice: r.notice, note: r.note, empty: r.empty, observed: r.observed,
    detailTop: state.detailTop, helpTop: state.helpTop, open: state.open !== null,
    detachKey: state.detachKey, opening: state.opening, openable: false,
    // The chords read now, `[key id, does]` (actions.mjs chordsRead), whether the terminal confirms
    // the kitty keyboard protocol, and whether every chord bound is read now (under the protocol, or
    // the Alt family, whose keys all come without it): then the help and a terminal's cheat sheet
    // lead with them.
    chords: [...chordsRead(state.chords, state.keyboard !== null)], kitty: state.keyboard !== null,
    chordsLead: state.chords.size > 0 && chordsRead(state.chords, state.keyboard !== null).size === state.chords.size,
    // Whether a chord shows the Nth tab (tab-1 to tab-9): the tabs carry their numbers only then
    // (views/frame.mjs stripRow). On macOS none does: ⌥⌘N never reaches a terminal.
    tabNumbers: [...state.chords.values()].some((does) => /^tab-[1-9]$/.test(does)),
    // The family the chords are bound in (keys.json, lib/config.mjs loadKeys), its name, and the line that says
    // why the file was not taken, or null (the shared chordFamilyNote): the help's chords section names both.
    // macOS has no family (`mac`): its chords are the arrows, whatever keys.json says.
    keys: state.mac === true ? MAC_KEYS : state.keysRead ? Object.freeze({ family: state.keysRead.family, label: CHORD_FAMILY_LABELS[state.keysRead.family] ?? CHORD_FAMILY_LABELS[DEFAULT_CHORD_FAMILY], note: chordFamilyNote(state.keysRead) }) : null,
    // The palette's own keys, `[key id, does]` (actions.mjs paletteKeys; none on macOS): its cheat
    // sheet and the help name them.
    paletteKeys: [...state.paletteKeys],
    terminal: state.terminal, onTerminal: false, scrollKeys: scrollKeys(state, r.instances, at),
    // The panel's groups (views/frame.mjs), the split and the focused group; the panel stands while
    // any tab is open. `tabs` is the focused group's strip: each tab in order, the shown one marked,
    // a hidden one's activity. A strip is drawn with two tabs or more; one reads as a title row.
    split: state.split, group: state.group, panelOpen: state.tabs.length > 0, groups: groupsOf(state, r, now),
    tabs: groupsOf(state, r, now)[state.group].tabs,
    act: state.view === "act" && state.act ? actView(state) : null,
    // The palette, while it is open.
    palette: state.palette === null ? null : paletteView(state, body, at),
    souls: under === "souls" ? soulsView(state, page, at) : null,
    capabilities: under === "capabilities" ? capabilitiesView(state, page, at) : null,
    spawn: state.spawn === null ? null : spawnView(state, body, at),
    // The line under the sidebar's title: the last outcome, else a spawn under way (outcomeOf).
    outcome: outcomeOf(state),
    // The list of workspaces at the top of the sidebar, and whether colour may say the dot.
    workspaces: listModel(state, under, at), colour: state.colour !== false,
  };
  if (under === "switcher") {
    const s = switcher(state, at);
    // The lines above the rows take the pane's rows, and so does the filter field while it is
    // typed or kept: the window is that much shorter, so no choice is hidden for them (switcherHeight).
    const win = switcherWindow(s.items, state.switcher.loose ? null : s.selected, { top: state.switcher.top, height: switcherHeight(state, body, area) });
    return {
      ...common, under, list: [], above: 0, below: 0, wordWidth: 0, detail: null,
      // Nothing of a workspace stands in the sidebar while the switcher is shown.
      workspace: "", machines: 0, here: false, machine: null, counts: [], readAt: null, notice: null, note: null, empty: null, observed: true, outcome: null,
      filter: Object.freeze({ editing: state.switcher.editing, query: state.switcher.query }),
      switcher: {
        rows: s.items.slice(win.top, win.top + win.size).map((item) => (item.key === undefined ? item : { ...item, selected: item.key === s.selected })),
        above: win.above, below: win.below, empty: s.empty, ...leadOf(state),
        // Whether the remove key acts on the selected row: a row of the list (the cheat sheet names it then).
        removable: s.items.some((item) => item.key === s.selected && item.path !== undefined),
      },
    };
  }
  const selected = state.selected === null ? -1 : r.index.get(state.selected) ?? -1;
  // What the detail and Enter read of the selected row is worked out once per paint.
  // The Background heading selected is no instance: it has no detail and nothing to open.
  const row = selected >= 0 ? r.items[selected].row ?? null : null, acts = row ? instanceActs(row) : null;
  const decision = row ? openDecision(state, row, acts) : null;
  // The window holds the selection, unless the list was scrolled away from it on purpose.
  const win = windowOf({ top: state.top, count: r.items.length, height: page, keep: state.loose ? -1 : selected });
  return {
    ...common, under,
    list: r.items.slice(win.top, win.top + win.size).map((item) => (item?.kind === "background" ? backgroundRow(state, item) : item?.id !== undefined ? { kind: "row", ...listRow(state, r, item) } : item)),
    above: win.above, below: win.below, wordWidth: r.wordWidth,
    detail: row !== null ? detailOf(state, r, r.items[selected], now, acts) : null,
    // The Background heading selected (#1579): whether Enter opens the section or closes it (the cheat
    // sheet); null while a filter is on, which draws it open and lets it change nothing.
    onBackground: !r.filtering && selected >= 0 && r.items[selected].kind === "background" ? (r.items[selected].open ? "open" : "closed") : null,
    // Enter opens the selected agent's terminal now, or (`onTerminal`) goes to the one open on it.
    openable: decision?.open === true && state.opening === null,
    onTerminal: row !== null && state.terminal !== null && state.terminal.id === instanceId(row),
    switcher: null,
  };
}

/** The shared home's rows of deployment `id` as the state holds them, unfiltered: the rows the list
 *  draws for it, found by the deployment and never by the view that is open. */
const rowsOf = (held, id) => panelData(held, id, TERMS).instances.filter((row) => row.deployment?.id === id);
/** Where a routed command runs from (its `localCwd`): the open deployment when it is this
 *  machine's, else the first served, else the home. */
export const actCwd = (state) => (state.ctxs.includes(state.open) ? state.open : state.ctxs[0] ?? state.home);
/** What the lifecycle boundary admits a request of deployment `id` against (its `getContext()`),
 *  asked at every admission: the deployment as the shared `deployments` lists it (a machine's with
 *  its roster group), the kernel record, `actCwd`, and that deployment's rows now. */
export function actContext(state, id, at) {
  const held = heldOf(state, at);
  const workspace = heldDeployments(held).find((w) => w.id === id) ?? null;
  return { workspace, cli: state.cli, localCwd: actCwd(state), instances: workspace ? rowsOf(held, id) : [] };
}
/** This machine's deployments and their rows, for the shared start rule's home check
 *  (session-start.mjs verifiedLocalHome). */
export function localDeployments(state, at) {
  const held = heldOf(state, at);
  return heldDeployments(held).filter((w) => !w.remote).map((w) => ({ id: w.id, remote: false, instances: rowsOf(held, w.id) }));
}

/** The four acts on an instance, in the order the help, the palette and the keys know them. */
export const ACT_VERBS = Object.freeze(["stop", "retire", "start", "restart"]);
const DONE = Object.freeze({ stop: "stopped", retire: "retired", start: "started", restart: "restarted" });
/** The TUI's own words around the acts (docs/tui.md, "Stopping, starting, restarting and
 *  retiring"), as parts the way OPEN_WORDS are: `{ own }` the TUI's, `{ shown }` a name. A
 *  lifecycle sentence the shared home has is never written here: the confirmation's view says it. */
export const ACT_WORDS = Object.freeze({
  notHere: (name, verb) => [{ shown: name }, { own: ` can't be ${DONE[verb]} here.` }],
  stillStarting: (name, verb) => [{ own: `The ${verb} of ` }, { shown: name }, { own: " is still running." }],
  /** The line on stderr after the TUI has left, one per change still running. */
  leaving: (verb, name) => `oats: the ${verb} of ${name} is still running; \`oats status\` shows its result.`,
  question: (name, verb) => [{ own: verb === "restart" ? "Restart " : "Start " }, { shown: name }, { own: "?" }],
  what: (verb) => (verb === "restart"
    ? "Its session is ended and started again: what it is doing is interrupted. Save any work in progress first."
    : "It starts with the launch settings recorded for it."),
  starting: (name, verb) => [{ own: verb === "restart" ? "Restarting " : "Starting " }, { shown: name }, { own: "…" }],
  started: (name, verb) => [{ shown: name }, { own: ` ${DONE[verb]}.` }],
  unconfirmed: (name) => [{ own: "OATS didn't confirm the start of " }, { shown: name }, { own: ". It may still be running: the list shows it when it is." }],
  waiting: "Esc stops waiting.",
  details: "Details:",
  since: "Started at",
  next: Object.freeze({
    "retire-with-force": (name) => [{ own: "Check the process it names, then retire it with `oats retire " }, { shown: name }, { own: " --force`." }],
    "check-roster": () => [{ own: "The list shows its result when it is done." }],
  }),
});
/** The labels of the buttons, the TUI's own, by the confirmation's offer (and the phase it is in). */
export function buttonLabel(offer, verb, phase) {
  if (offer === "close") {
    if (phase === "reading" || phase === "review") return "Cancel";
    if (phase === "applying" || phase === "starting") return `Close (the ${verb} goes on)`;
    return "Close";
  }
  if (offer === "refresh") return "Review again";
  if (offer === "check-again") return "Check again";
  return { stop: "Stop", retire: "Retire", start: "Start", restart: "Restart" }[verb];
}
/** The order the buttons stand in, whatever order the offers come in: the first has the focus. */
export const BUTTON_ORDER = Object.freeze(["close", "refresh", "check-again", "apply"]);

/** Whether an act key on `row` opens a confirmation, and what the line says when it does not.
 *  `acts` is the row's instanceActs answer, read once per paint (the palette) or per key, as
 *  openDecision reads it; nothing here decides which acts a row has.
 *    { open: true, verb, id, name, kind, machine, label, home }  a confirmation opens: `kind`
 *        "lifecycle" for stop and retire (the shared confirmation), "start" for the TUI's own
 *    { open: false, said: { said, under } }                    nothing opens, and this says why
 *  In order: a start or restart of this row from this TUI still running (Done 7); the verb listed
 *  and enabled (start and restart also asked of the shared startGate); listed and not enabled
 *  (its own reason); not listed (the row's blocked or limited reason, else the TUI's words). */
export function actDecision(state, row, acts, verb) {
  const name = row.instance, id = instanceId(row);
  const no = (said, under = []) => ({ open: false, said: { said, under } });
  const running = state.starting?.get(id);
  if (running) return no(ACT_WORDS.stillStarting(name, running.verb));
  const act = acts.acts.find((each) => each.verb === verb);
  if (!act) {
    const held = acts.blocked ?? acts.limited;
    return held ? no([], outside(reasonSpoken(held))) : no(ACT_WORDS.notHere(name, verb));
  }
  if (!act.enabled) return no([], outside(reasonSpoken(act.reason)));
  const lifecycle = verb === "stop" || verb === "retire";
  if (!lifecycle) {
    const refused = startGate(state.cli, row, { restart: verb === "restart" }, TERMS);
    // The gate's `detail` is the row's own text: said as the detail says it, with its speaker.
    if (refused) return no([], [refused.sentence, ...outside(refused.detail ? rowText(row, acts) : null)]);
  }
  const machine = elsewhere(row) ? row.deployment?.machine ?? row.server : null;
  return { open: true, verb, id, name, kind: lifecycle ? "lifecycle" : "start", machine, label: machine, home: row.home ?? null };
}

/** The TUI's own words around the pin key (feature instance-pin; docs/tui.md, "Pinning"), as parts the way
 *  ACT_WORDS are. `unavailable` says why the key does nothing on a kernel that does not list the feature, and the
 *  command that pins. */
export const PIN_WORDS = Object.freeze({
  unavailable: [{ own: "This OATS can't pin instances: it doesn't list instance-pin. With a newer one, p or `oats instance pin <name> on|off` pins." }],
  pinning: (name, pinned) => [{ own: pinned ? "Pinning " : "Unpinning " }, { shown: name }, { own: "…" }],
  still: (name) => [{ own: "The pin of " }, { shown: name }, { own: " is still changing." }],
  done: (name, pinned) => [{ shown: name }, { own: pinned ? " is pinned to the top of its machine's list." : " is unpinned." }],
  notChanged: (name) => [{ own: "The pin of " }, { shown: name }, { own: " was not changed." }],
  unconfirmed: (name) => [{ own: "OATS didn't confirm the pin of " }, { shown: name }, { own: ". The list shows it once it is read again." }],
});

/** What the pin key does on `row` (`acts`: its instanceActs answer): `{ open: true, id, name, pinned }`, `pinned`
 *  the value it sets (Unpin on a pinned row, else Pin), or `{ open: false, said }`, the line that says why not:
 *  without the feature, while this run's pin of the row is still changing, or on a row that offers no act of a
 *  client's own (a held, retiring or unaddressable home: the shared reason). A remote row's host without the
 *  feature is the kernel's to refuse (E_REMOTE_INCOMPATIBLE: nothing is sent), said as its refusal. */
export function pinDecision(state, row, acts) {
  const name = row.instance, id = instanceId(row);
  const no = (said, under = []) => ({ open: false, said: Object.freeze({ said, under }) });
  if (!pinsListed(state)) return no(PIN_WORDS.unavailable);
  if (state.pinning?.has(id)) return no(PIN_WORDS.still(name));
  const held = acts.blocked ?? acts.limited;
  if (held) return no([], outside(reasonSpoken(held)));
  return { open: true, id, name, pinned: row.pinned !== true };
}

/** The line after a pin's answer (packages/client instance-pin.mjs pinOutcome): the change, the kernel's refusal
 *  under the TUI's sentence, or that OATS did not confirm it (the list read after it says what is true). */
export function pinLine(name, pinned, answer) {
  if (answer?.status === "ok" && answer.pinned === pinned) return Object.freeze({ said: PIN_WORDS.done(name, pinned), under: Object.freeze([]) });
  if (answer?.status === "refused") {
    const said = kernelLines(answer.reason?.message, undefined, TERMS);
    return Object.freeze({ said: PIN_WORDS.notChanged(name), under: Object.freeze(said.length ? said : outside(displayLine(answer.reason?.code))) });
  }
  return Object.freeze({ said: PIN_WORDS.unconfirmed(name), under: Object.freeze([]) });
}

/** What a start's or a restart's answer (the shared startInstance's) shows, as the act view's
 *  lines: `{ said }` the TUI's own sentence in parts, `{ text }` a shared sentence or the kernel's
 *  line (each already as the shared home words it). Chosen by the answer's fields and codes, never
 *  by its words. */
export function startOutcome(name, verb, answer) {
  const lines = [];
  const kernel = (detail) => (detail ? kernelLines(detail, undefined, TERMS).map((text) => ({ text })) : []);
  if (answer?.ok === true) {
    const fact = launchFlagIgnored(answer.result), notice = fact ? flagIgnoredNotice(name, fact) : null;
    if (notice) return [{ text: notice.headline, look: "bold" }, ...(notice.detail ? notice.detail.split("\n").map((text) => ({ text })) : [])];
    return [{ said: ACT_WORDS.started(name, verb), look: "bold" }];
  }
  if (answer?.outcome === "refused") {
    lines.push({ text: answer.sentence, look: "bold" });
    // A refusal before the CLI ran (the gate, the home check) carries the row's own text, if any.
    if (answer.ran) lines.push(...kernel(answer.detail));
    else if (answer.detail) lines.push({ text: answer.detail });
    return lines;
  }
  // The end of the wait for a start that goes on: the code the shared rule leaves to each client to
  // word. No answer at all (the call itself was refused by the loop) is no more than that either.
  if (!answer || answer.code === "E_START_UNCONFIRMED") return [{ said: ACT_WORDS.unconfirmed(name), look: "bold" }];
  if (answer.incomplete) return [{ text: retainedStartMessage(name, answer.incomplete), look: "bold" }, ...kernel(answer.detail)];
  return [{ text: answer.sentence ?? answer.code, look: "bold" }, ...kernel(answer.detail)];
}

/** An ISO-less clock time, `14:03`, of milliseconds since the epoch, or null. */
const hourMinute = (ms) => { const at = new Date(ms); return Number.isFinite(ms) && Number.isFinite(at.getTime()) ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : null; };

/** The act view's content for the open confirmation (`state.act`), top to bottom, each part only
 *  when it has something: { title, lines, buttons }. A line is `{ text, look?, path? }` (a shared
 *  sentence or the kernel's text, drawn through the display filter; `path` after it, shortened),
 *  `{ said, look? }` (the TUI's own sentence, in parts), `{ pair: [label, value] }` (a state row: both from outside, the plan's label a target's name among them),
 *  `{ choice: { id, sentence, value } }` or `{ gap: true }`. `look`: "bold", "dim". */
export function actView(state) {
  const a = state.act;
  const lines = [];
  const gap = () => { if (lines.length && !lines.at(-1).gap) lines.push({ gap: true }); };
  const short = (path) => shortPath(path, { home: a.machine === null ? state.home : null });
  let title;
  if (a.kind === "start") {
    title = { said: ACT_WORDS.question(a.name, a.verb) };
    if (a.phase === "review") {
      lines.push({ own: ACT_WORDS.what(a.verb) });
      gap();
      if (a.machine !== null) lines.push({ pair: ["machine", a.machine] });
      if (a.home) lines.push({ pair: ["home", short(a.home)] });
    } else if (a.phase === "starting") lines.push({ said: ACT_WORDS.starting(a.name, a.verb) });
    else lines.push(...startOutcome(a.name, a.verb, a.answer));
  } else {
    const view = a.view ?? {}, plan = a.plan;
    title = { text: plan && (a.phase === "review" || view.kind === "reading") ? plan.question : view.title ?? "" };
    if (a.notice?.sentence) lines.push({ text: a.notice.sentence, look: "bold" });
    if (view.kind === "reading" || view.kind === "applying") {
      lines.push({ text: view.message });
      if (view.kind === "reading") lines.push({ own: ACT_WORDS.waiting, look: "dim" });
    }
    if (plan && (a.phase === "review" || view.kind === "reading")) {
      gap();
      for (const h of plan.happening) lines.push({ text: h.text, ...(h.path ? { path: short(h.path) } : {}), ...(h.tone === "attention" ? { look: "bold" } : h.tone === "note" ? { look: "dim" } : {}) });
      if (plan.state.rows.length || plan.state.notes.length) gap();
      for (const row of plan.state.rows) lines.push({ pair: [row.label, row.value] });
      for (const note of plan.state.notes) lines.push({ text: note.text, ...(note.tone === "attention" ? { look: "bold" } : note.tone === "note" ? { look: "dim" } : {}) });
      if (plan.warning) lines.push({ text: plan.warning, look: "bold" });
      const offered = plan.choices.filter((choice) => choice.offered);
      if (offered.length) gap();
      for (const choice of offered) lines.push({ choice: { id: choice.id, sentence: choice.sentence, value: choice.value } });
      if (plan.notice?.sentence) lines.push({ text: plan.notice.sentence, look: "bold" });
    }
    if (a.phase === "settled" && view.status) {
      gap();
      lines.push({ text: view.status.headline, look: "bold" });
      for (const more of view.status.more ?? []) {
        if (more.quote !== undefined) lines.push(...kernelLines(more.quote, undefined, TERMS).map((text) => ({ text })));
        else lines.push({ text: more.text });
      }
      if (view.status.next && ACT_WORDS.next[view.status.next]) lines.push({ said: ACT_WORDS.next[view.status.next](a.name) });
      for (const block of view.blocks ?? []) {
        if (block.type === "details") {
          lines.push({ said: [{ own: `${ACT_WORDS.details} ` }, { shown: block.reason?.code ?? "" }], look: "dim" });
          lines.push(...kernelLines(block.reason?.detail, undefined, TERMS).map((text) => ({ text })));
        } else if (block.type === "quote") lines.push(...kernelLines(block.text, undefined, TERMS).map((text) => ({ text })));
        else if (block.type === "note") lines.push({ text: block.text });
        else if (block.type === "rows") for (const row of block.rows) { lines.push({ text: row.text }); if (row.quote) lines.push(...kernelLines(row.quote, undefined, TERMS).map((text) => ({ text }))); }
        else if (block.type === "lines") for (const line of block.lines) lines.push({ text: line.text, ...(line.path ? { path: short(line.path) } : {}) });
      }
    }
    const since = a.running ? hourMinute(a.running.since) : null;
    if (since) lines.push({ own: `${ACT_WORDS.since} ${since}.`, look: "dim" });
  }
  const buttons = a.offers.map((offer) => ({ id: offer, label: buttonLabel(offer, a.verb, a.phase), focused: offer === a.focus }));
  return { title, lines, buttons, top: a.top };
}

// ── THE SOULS VIEW (docs/tui.md, "The Souls view") ───────────────────────────────────────────────

/** The names an instance's soul (its row's `agent`) may carry for a soul row: its name, and for a
 *  package soul the kernel's key, its qualified name and its name in the roster, `<package>--<soul>`
 *  (the shared rosterAgentName: the agent directory a package soul's instances are made under). The
 *  exact soul filter, the count of a soul's instances and "Used by" match these. */
export function soulNames(row) {
  return [...new Set([row.name, row.key, row.qualifiedName, rosterAgentName(row)].filter(text))];
}

/** The souls of the open workspace as the store and the view read them: the shared rows
 *  (soul-rows.mjs soulRows) of the catalog the loop holds for it, filtered by the view's own
 *  filter. Only a workspace of this machine has souls here (`local`). `held` is what the loop
 *  holds of its catalog (`{ entry, reading }`), `rows` the rows the filter keeps, `selected` the
 *  row the selection stands on: the store's, while it is listed, else the first. */
export function soulsOf(state) {
  const { local, deployment, held, all } = catalogOf(state, state.open);
  // The Souls view's filter is the Desktop's soul grid's (soulMatches), on the trimmed text.
  const query = state.souls.filter.query.trim();
  const rows = query ? all.filter((row) => soulMatches(row, query)) : all;
  const selected = rows.find((row) => row.name === state.souls.selected) ?? rows[0] ?? null;
  return { local, deployment, held, all, rows, selected };
}

/** The souls of workspace `id` (one of this machine's, or nothing): its observed deployment, what
 *  the loop holds of its catalog, and the shared rows of that catalog. */
function catalogOf(state, id) {
  const local = id !== null && state.ctxs.includes(id);
  const entry = local ? state.entries.get(id) ?? null : null;
  const deployment = entry?.deployment?.status === "observed" ? entry.deployment : null;
  const held = local ? state.souls.held.get(id) ?? null : null;
  const all = deployment && Array.isArray(held?.entry?.souls) ? soulRows(deployment, held.entry.souls) : [];
  return { local, deployment, held, all };
}

/** The most instances the detail names; the rest are counted, `+n`. */
const INSTANCES_NAMED = 8;

/** This machine's instances of a soul in the open workspace, in the list's order: the rows of
 *  another machine are not counted, since the view is of this machine's souls. */
function instancesOf(state, at, row) {
  const names = soulNames(row);
  return roster(state, at).ordered.filter((each) => !elsewhere(each) && names.includes(each.agent));
}

/** Where a soul comes from, in one value: the member it is in, and for a package soul the package
 *  and its version (the shared row's `repoName` already names the package when no member does). */
function soulFrom(row) {
  if (row.soulKind !== "package" || !text(row.package)) return row.repoName;
  const pkg = `package ${row.package}${text(row.version) ? ` ${row.version}` : ""}`;
  return row.repoName === `package ${row.package}` || !text(row.repoName) ? pkg : `${row.repoName} · ${pkg}`;
}

/** The selected soul's detail, from its row and the shared facts (soul-facts.mjs soulFacts, with
 *  no inspection): nothing of a soul is worded here but the labels the view puts beside them. */
function soulDetail(state, at, row) {
  const facts = soulFacts(row, null, state.cli, TERMS);
  const teams = Array.isArray(row.teams) && row.teams.length
    ? [...row.teams].sort((a, b) => (b.default === true) - (a.default === true)).map((team) => ({ label: team.label, default: team.default === true || team.label === row.defaultTeam?.label }))
    : null;
  const capabilities = Array.isArray(row.capabilities) && row.capabilities.length ? row.capabilities.map((c) => c.name) : null;
  const here = instancesOf(state, at, row);
  return {
    name: row.name, description: row.description ?? "", from: soulFrom(row), works: facts.work, refusal: facts.refusalLine,
    harness: { rows: facts.rows, notes: facts.notes, problem: facts.problem },
    teams, capabilities,
    instances: { shown: here.slice(0, INSTANCES_NAMED).map((each) => ({ name: each.instance, mark: markOf(each), color: rowColour(each) })), more: Math.max(0, here.length - INSTANCES_NAMED) },
  };
}

/** What the Souls view draws, in a list pane `page` rows tall (views/souls.mjs): the state of the
 *  catalog, the window of its rows, and the selected soul's detail. A failed re-read keeps the
 *  rows it held, and says so on a heading above them, as a machine's heading says it. */
function soulsView(state, page, at) {
  const s = soulsOf(state), v = state.souls;
  const base = { local: s.local, failure: null, heading: null, list: [], above: 0, below: 0, focus: v.focus, filter: v.filter, detail: null, detailTop: v.detailTop };
  if (!s.local) return { ...base, state: "none" };
  const entry = s.held?.entry ?? null, reason = entry?.reason ?? null;
  if (!Array.isArray(entry?.souls)) {
    // Nothing held: the first read is in flight (or the deployment not read yet), or it failed.
    return reason && !s.held.reading ? { ...base, state: "failed", failure: soulCatalogFailure(reason) } : { ...base, state: "reading" };
  }
  // A failed re-read's heading: the accordion's row above it names the view, so it has no word of its own.
  const heading = reason ? { label: "", path: null, state: null, short: soulCatalogFailure(reason), readAt: clockTime(entry.observedAt) } : null;
  const state_ = !s.all.length ? "none" : !s.rows.length ? "nomatch" : "rows";
  const height = Math.max(1, page - (heading ? 1 : 0));
  const at_ = s.selected ? s.rows.indexOf(s.selected) : -1;
  const win = windowOf({ top: v.top, count: s.rows.length, height, keep: v.loose ? -1 : at_ });
  const count = (row) => instancesOf(state, at, row).length;
  return {
    ...base, state: state_, heading,
    list: s.rows.slice(win.top, win.top + win.size).map((row) => ({
      name: row.name, color: SOUL_COLOURS[row.color] ?? null, count: count(row), refused: spawnRefusal(row, state.cli) !== null, selected: row === s.selected,
    })),
    above: win.above, below: win.below,
    // The heading has room for little of a failed re-read's sentence: the detail holds it whole,
    // as a machine's full reason stands in the detail of each of its rows.
    detail: s.selected ? { ...soulDetail(state, at, s.selected), failure: heading ? heading.short : null } : null,
  };
}

// ── THE CAPABILITIES VIEW (docs/tui.md, "The Capabilities view"; Spec 7) ──────────────────────────

/** A capability's identity in the view: its source's key and its name, since a package's capability
 *  and a member's may share a name (Spec 7, Settled 8). */
export const capabilityKey = (row, names) => `${capabilitySource(row, names).key}\u0000${row.name}`;

/** The view's sections, in the order they stand (the Desktop's): Workspace owned, Repo owned, Packages. */
const SECTION_ORDER = Object.freeze(["workspace", "repo", "packages"]);

/** The capabilities of the open workspace as the store and the view read them: the rows of the
 *  catalog the loop holds for it (`held`, `{ entry, reading }`), filtered by the view's own filter
 *  (the shared matchCapabilities), in the shared sections (capabilitySections) and groups
 *  (groupCapabilities), as `items` in drawn order: `{ section }` (a section's heading), `{ group, note }`
 *  (a repository's or a package's), and `{ key, row }` (a capability). A section or a group with no
 *  row is not listed. `keys` are the capabilities in order, `selected` the key the selection stands
 *  on (the store's while it is listed, else the first) and `row` its row; `heading` whether a failed
 *  re-read's heading stands above the rows. Only a workspace of this machine has them (`local`). */
export function capabilitiesOf(state) {
  const id = state.open, local = id !== null && state.ctxs.includes(id);
  const entry = local ? state.entries.get(id) ?? null : null;
  const deployment = entry?.deployment?.status === "observed" ? entry.deployment : null;
  const held = local ? state.capabilities.held.get(id) ?? null : null;
  const status = deployment?.workspaceStatus ?? null;
  const listed = deployment !== null && Array.isArray(held?.entry?.capabilities?.capabilities);
  const all = listed ? held.entry.capabilities.capabilities : [];
  const names = memberNames(status), hostKey = hostKeyOf(status);
  const sections = capabilitySections(matchCapabilities(all, state.capabilities.filter.query));
  const items = [];
  for (const section of SECTION_ORDER) {
    if (!sections[section].length) continue;
    items.push({ section });
    for (const group of groupCapabilities(sections[section], names, hostKey)) {
      items.push({ group: group.name, note: group.note });
      for (const row of group.rows) items.push({ key: capabilityKey(row, names), row });
    }
  }
  const keys = items.filter((item) => item.key !== undefined).map((item) => item.key);
  const selected = keys.includes(state.capabilities.selected) ? state.capabilities.selected : keys[0] ?? null;
  const row = selected === null ? null : items.find((item) => item.key === selected).row;
  return { local, deployment, status, held, listed, all, items, keys, selected, row, heading: listed && Boolean(held.entry.reason) };
}
/** The rows the list of capabilities has in a pane `page` rows tall: a failed re-read's heading takes one. */
export const capabilitiesHeight = (c, page) => Math.max(1, page - (c.heading ? 1 : 0));

/** "Used by" of capability `row` (capability-rows.mjs capabilityUsers): with the kernel's
 *  souls-capabilities, the souls of the open workspace's catalog whose composition includes it; before
 *  it, the souls whose instances carry it. `instances` are this machine's rows of the open workspace.
 *  Each user is drawn by its catalog row (soulOfAgent maps an instance's agent name to it): its name
 *  and colour, and the soul Enter shows in the Souls view (`soul`, null when no row matches); `count`
 *  its instances carrying the capability, and `behind` the shared words for those on an older
 *  version, or null. Until the souls catalog is read the souls are not known (`reading`, or `failed`
 *  with its sentence): nothing claims that no soul includes it. */
export function capabilityUsersOf(state, at, row) {
  const composition = soulsComposition(state.cli), souls = catalogOf(state, state.open), entry = souls.held?.entry ?? null;
  const none = { shown: [], more: 0, count: null, empty: null, failure: null };
  if (composition && !Array.isArray(entry?.souls)) return { ...none, state: entry?.reason && !souls.held.reading ? "failed" : "reading", failure: entry?.reason && !souls.held.reading ? soulCatalogFailure(entry.reason) : null };
  const instances = roster(state, at).ordered.filter((each) => !elsewhere(each) && each.deployment?.id === state.open);
  const users = capabilityUsers(row, { souls: souls.all, instances, composition }).map(({ soul, carrying, behind }) => {
    const found = composition ? soul : soulOfAgent(state, state.open, soul.name);
    return { name: found?.name ?? soul.name, color: found ? SOUL_COLOURS[found.color] ?? null : null, count: carrying.length, behind: behind > 0 ? CAPABILITY_COPY.behind(behind) : null, soul: found?.name ?? null };
  });
  return {
    ...none, state: "known", shown: users.slice(0, INSTANCES_NAMED), more: Math.max(0, users.length - INSTANCES_NAMED), count: CAPABILITY_COPY.souls(users.length),
    empty: users.length ? null : composition ? CAPABILITY_COPY.noSoul : CAPABILITY_COPY.noInstance,
  };
}

/** The selected capability's detail, from its row and the shared facts (capability-facts.mjs
 *  capabilityFacts) in the shared words (CAPABILITY_COPY): nothing of a capability is worded here. A
 *  kind of Provides the kernel could not list (`names` null) says CAPABILITY_COPY.unlistable, and one
 *  with no name CAPABILITY_COPY.none. `comesFrom` holds the facts' "Comes from" rows as `{ label,
 *  value }`, the shortened value (not `origin`: in this package that names a reason's speaker, which
 *  test/tui-boundary.test.mjs holds to originLead). */
function capabilityDetail(state, at, c) {
  const row = c.row, { origin, provides } = capabilityFacts(row, { status: c.status });
  return {
    name: row.name, layer: text(row.layer) ? layerLabel(row.layer) : null, description: row.description ?? "",
    words: { comesFrom: CAPABILITY_COPY.comesFrom, provides: CAPABILITY_COPY.provides, usedBy: CAPABILITY_COPY.usedBy },
    comesFrom: origin.map(([label, value]) => ({ label, value })),
    provides: provides.map(([label, names]) => ({ label, names: names ?? [], said: names === null ? CAPABILITY_COPY.unlistable : names.length ? null : CAPABILITY_COPY.none })),
    used: capabilityUsersOf(state, at, row),
  };
}

/** What the Capabilities view draws, in a list pane `page` rows tall (views/capabilities.mjs): the
 *  state of the catalog, the window of its items, and the selected capability's detail with the soul
 *  of "Used by" that has the detail's mark (`mark`, an index of its listed souls). A failed re-read
 *  keeps the rows it held, under a heading that says so, as the Souls view's does. */
function capabilitiesView(state, page, at) {
  const c = capabilitiesOf(state), v = state.capabilities;
  const base = { local: c.local, failure: null, heading: null, list: [], above: 0, below: 0, focus: v.focus, filter: v.filter, detail: null, detailTop: v.detailTop, keep: !v.detailLoose, mark: v.mark };
  if (!c.local) return { ...base, state: "none" };
  const entry = c.held?.entry ?? null, reason = entry?.reason ?? null;
  if (!c.listed) return reason && !c.held.reading ? { ...base, state: "failed", failure: catalogFailure("capabilities", reason) } : { ...base, state: "reading" };
  const heading = c.heading ? { label: "", path: null, state: null, short: catalogFailure("capabilities", reason), readAt: clockTime(entry.observedAt) } : null;
  const state_ = !c.all.length ? "none" : !c.keys.length ? "nomatch" : "rows";
  const at_ = c.items.findIndex((item) => item.key !== undefined && item.key === c.selected);
  const win = windowOf({ top: v.top, count: c.items.length, height: capabilitiesHeight(c, page), keep: v.loose ? -1 : at_ });
  const detail = c.row ? capabilityDetail(state, at, c) : null;
  return {
    ...base, state: state_, heading,
    list: c.items.slice(win.top, win.top + win.size).map((item) => (item.key === undefined ? item
      : { name: item.row.name, layer: text(item.row.layer) ? layerLabel(item.row.layer) : null, selected: item.key === c.selected })),
    above: win.above, below: win.below,
    detail: detail && { ...detail, failure: heading ? heading.short : null },
    // The mark stands on a listed soul only: the store keeps it inside them.
    mark: detail && v.focus === "detail" && detail.used.shown.length ? Math.min(v.mark, detail.used.shown.length - 1) : -1,
  };
}

// ── SPAWNING (docs/tui.md, "Spawning an agent"; Spec 6-spawn) ───────────────────────────────────

/** A shared sentence as parts the outcome line wraps (views/frame.mjs partRows): each word is
 *  text from outside, and the gaps between them are the TUI's. */
const sentenceParts = (text) => String(text ?? "").split(/ +/).filter(Boolean).flatMap((word, i) => (i ? [{ own: " " }, { shown: word }] : [{ shown: word }]));
/** The label of the first key the effective table gives action `id`, or the action's id. */
const keyOf = (actions, id) => { const a = actions.find((each) => each.id === id && each.keys.length); return a ? keyLabel(a.keys[0]) : id; };

/** The TUI's own words around a spawn, as parts the way ACT_WORDS are. Every fact of a spawn (what
 *  happened, what the preview holds, why a soul can't be spawned) is the shared home's
 *  (spawn-messages.mjs, spawn-preview-facts.mjs, soul-facts.mjs): the TUI words only what follows a
 *  fact (`next`, naming its own keys), and the prompt around them. */
export const SPAWN_WORDS = Object.freeze({
  /** From the press of Enter until the outcome. */
  spawning: (name) => [{ own: "Spawning " }, { shown: name }, { own: "\u2026" }],
  checking: (name) => [{ own: "Checking the spawn of " }, { shown: name }, { own: "\u2026" }],
  /** n or N while a spawn is under way: one at a time. */
  busy: (name) => [{ own: "The spawn of " }, { shown: name }, { own: " is still under way: one spawn at a time." }],
  /** n or N on another machine's row or workspace (#855: remote spawn is out of scope here). */
  remote: () => [{ own: "Spawning on another machine is not offered here;" }, { own: " " }, command("oats spawn"), { own: " there makes one." }],
  /** N on a row whose soul the workspace's catalog does not list. */
  noSoul: (soul) => [{ own: "The soul " }, { shown: soul }, { own: " isn't in this workspace's catalog: there is nothing to spawn." }],
});

/** THE TUI'S WORDS FOR WHAT FOLLOWS A SPAWN'S FACT, one entry per SPAWN_NEXT code
 *  (spawn-messages.mjs): each names a key of the effective table, or an `oats` command
 *  (test/tui-... pins that every code has one). `(instance, actions)` -> parts. */
export const SPAWN_NEXT_WORDS = Object.freeze({
  "change-options": () => [{ own: "Change the choices with Tab and Enter." }],
  "review-again": () => [{ own: "Check the preview and press Enter again." }],
  "check-result": (_, actions) => [{ own: `Press ${keyOf(actions, "spawn-check")} to check before spawning again.` }],
  "update-oats": () => [{ own: "Update OATS with" }, { own: " " }, command("oats update"), { own: ", then try again." }],
  "choose-workspace": (_, actions) => [{ own: `Choose it again with ${keyOf(actions, "workspaces")}.` }],
  "sync-workspace": () => [{ own: "Run" }, { own: " " }, command("oats sync"), { own: " in the workspace, then try again." }],
  details: () => [{ own: "The details below say more." }],
  retire: (instance, actions) => [{ own: "Retire " }, { shown: instance ?? "it" }, { own: ` with ${keyOf(actions, "retire")} to finish its cleanup.` }],
  "view-schedules": () => [command("oats schedule list"), { own: " shows its schedules." }],
  "open-from-list": (_, actions) => [{ own: `Open it from the list with ${keyOf(actions, "open")}.` }],
});

/** A spawn's words as the outcome line (or the prompt's) says them, `{ said, under }`: the shared
 *  fact, then the TUI's words for its `next`; under them the shared `detail` (the code and the
 *  kernel's message) where the next act is to read it. `words`: spawnProblem's or outcomeWords'. */
export function spawnLine(words, instance, actions) {
  if (!words) return null;
  const next = words.next && Object.hasOwn(SPAWN_NEXT_WORDS, words.next) ? SPAWN_NEXT_WORDS[words.next](words.instance ?? instance, actions) : [];
  return { said: [...sentenceParts(words.fact), ...(next.length ? [{ own: " " }, ...next] : [])], under: words.next === "details" && words.detail ? [words.detail] : [] };
}

/** The line above the panes: the last outcome; else, while a spawn is under way, what it does. */
export function outcomeOf(state) {
  if (state.outcome !== null) return state.outcome;
  const s = state.spawning;
  return s ? { said: (s.phase === "checking" ? SPAWN_WORDS.checking : SPAWN_WORDS.spawning)(s.name), under: [] } : null;
}

/** The choices a prompt asks the preview for: the shared defaults, the name typed (`--purpose`),
 *  and the parent when "child of" is on. Nothing else is offered here (out of scope: harness,
 *  model, work mode, teams). */
export function spawnChoices(p) {
  return {
    ...defaultSpawnChoices(),
    ...(p.name ? { purpose: p.name } : {}),
    ...(p.child && p.anchor ? { relation: { kind: "child", anchor: { instance: p.anchor.instance, agent: p.anchor.agent, agentsRoot: p.anchor.agentsRoot, server: null } } } : {}),
  };
}
/** The choices as one value, to tell whether the preview on screen was read for them. */
export const spawnChoicesKey = (p) => JSON.stringify(spawnChoices(p));
/** The soul a preview is read for, as the shared preview selects it. */
export const spawnSelector = (p) => ({ soul: p.soul.name, agentsRoot: p.soul.agentsRoot });

/** What the spawn boundaries admit a request of workspace `id` against (their `getContext()`),
 *  asked at every admission: the deployment as the shared `deployments` lists it, the kernel
 *  record, its souls (the catalog's shared rows) and its rows now. */
export function spawnContext(state, id, at) {
  const held = heldOf(state, at);
  const workspace = heldDeployments(held).find((w) => w.id === id) ?? null;
  return { workspace, cli: state.cli, agents: catalogOf(state, id).all, instances: workspace ? rowsOf(held, id) : [] };
}

/** The soul row of workspace `id` an instance's soul (its row's `agent`) names, or null. */
export function soulOfAgent(state, id, agent) {
  return catalogOf(state, id).all.find((row) => soulNames(row).includes(agent)) ?? null;
}

/** The picker's rows: the souls of the prompt's workspace, filtered by the query with the palette's
 *  subsequence score (the best first, a tie in the catalog's order). `selected` is the soul the
 *  selection stands on: the prompt's, while it is listed, else the first. */
export function spawnPickerItems(state) {
  const p = state.spawn, c = catalogOf(state, p.workspace), query = p.query.trim();
  const items = (query === "" ? c.all : c.all.map((row, i) => ({ row, i, score: subsequenceScore(row.name, query) })).filter((each) => each.score !== null).sort((a, b) => a.score - b.score || a.i - b.i).map(({ row }) => row))
    .map((row) => ({ name: row.name, row, refused: spawnRefusal(row, state.cli) !== null }));
  return { catalog: c, items, selected: items.some((item) => item.name === p.selected) ? p.selected : items[0]?.name ?? null };
}

/** The folded parts a preview's data has, in order: the launch-prompt policy, the capabilities'
 *  warnings and the modules, where it carries them (previewFacts makes `prompts`, `warnings` and
 *  `modules` of exactly these). */
const foldKeys = (data) => (data ? [
  ...(data.launchPromptAnswers ? ["prompts"] : []),
  ...(Array.isArray(data.warnings) && data.warnings.length ? ["warnings"] : []),
  ...(Array.isArray(data.modules) ? ["modules"] : []),
] : []);
/** Each fold of a preview, one row until opened: the labels and the one-line summaries are the
 *  TUI's; what they fold is the shared facts'. */
function spawnFolds(data, facts) {
  const caps = facts?.modules?.caps.length ?? 0, core = facts?.modules?.core.filter((slot) => slot.module).length ?? 0;
  const made = {
    prompts: { label: "Launch prompts", summary: "what the launcher answers for this home" },
    warnings: { label: "Warnings", summary: `${facts?.warnings.length ?? 0} from its capabilities; they block nothing` },
    modules: { label: "Modules", summary: `${core} core, ${caps} other capabilit${caps === 1 ? "y" : "ies"}` },
  };
  return foldKeys(data).map((key) => ({ key, ...made[key] }));
}
/** The preview's focus ring, in Tab's order: Spawn, the name, child of (when offered), each fold. */
export const spawnRing = (p) => ["spawn", "name", ...(p.anchor ? ["child"] : []), ...foldKeys(p.data).map((key) => `fold:${key}`)];

/** The row of the instance a spawn created (`arriving`), as the Desktop's spawn jobs find it
 *  (spawn-jobs.mjs `observe`): its workspace's rows holding exactly one of that instance, home,
 *  root and soul, on this machine. Null while there is none. */
export function spawnedRow(state, a, at = new Date(0).toISOString()) {
  const same = rowsOf(heldOf(state, at), a.workspace).filter((row) => row.instance === a.instance && row.home === a.home && row.agentsRoot === a.agentsRoot
    && (a.agent === null || a.agent === undefined || row.agent === a.agent) && !row.server);
  return same.length === 1 ? same[0] : null;
}

/** The preview's facts as the shared home words them: the name typed, else the kernel's; where
 *  it runs in the Desktop's words for the deployment (deployment-label.mjs). Null before an answer. */
function spawnFacts(state, p, at) {
  if (!p.data) return null;
  const workspace = heldDeployments(heldOf(state, at)).find((w) => w.id === p.workspace) ?? null;
  return previewFacts(p.data, { name: p.name || p.data.instance || null, runsOn: workspace ? deploymentLabel(workspace, TERMS) : null, cli: state.cli });
}
/** Whether the preview on screen is the one Enter on Spawn would spawn: read, and for the choices shown. */
export const spawnReady = (p) => p.step === "preview" && p.status === "shown" && p.data !== null && p.readKey === spawnChoicesKey(p);

/** The prompt as views/spawn.mjs draws it (that file has the shape), in a body `page` rows tall. */
function spawnView(state, page, at) {
  const p = state.spawn;
  if (p.step === "picker") {
    const list = spawnPickerItems(state), c = list.catalog, entry = c.held?.entry ?? null;
    const height = Math.max(1, page - 2), at_ = list.items.findIndex((item) => item.name === list.selected);
    const win = windowOf({ top: 0, count: list.items.length, height, keep: at_ });
    const reading = !Array.isArray(entry?.souls), failed = reading && entry?.reason && !c.held?.reading;
    return {
      step: "picker", query: p.query,
      rows: list.items.slice(win.top, win.top + win.size).map((item) => ({ name: item.name, refused: item.refused, refusal: item.refused ? soulFacts(item.row, null, state.cli, TERMS).refusalLine : null, selected: item.name === list.selected })),
      above: win.above, below: win.below,
      state: failed ? "failed" : reading ? "reading" : !c.all.length ? "none" : !list.items.length ? "nomatch" : "rows",
      failure: failed ? soulCatalogFailure(entry.reason) : null,
    };
  }
  const facts = spawnFacts(state, p, at), ring = spawnRing(p);
  const focus = ring.includes(p.focus) ? p.focus : "spawn";
  const folds = spawnFolds(p.data, facts).map((fold) => ({ ...fold, open: p.folds.includes(fold.key), focused: focus === `fold:${fold.key}` }));
  const problem = p.problem ?? (p.status === "failed" ? spawnLine(spawnProblem(p.reason, "preview"), p.name || null, state.actions) : null);
  const ready = spawnReady(p);
  const enter = focus === "spawn" ? (ready ? "spawn" : p.status === "failed" && p.soul !== null ? "read again" : null)
    : focus === "name" ? "keep the name"
    : focus === "child" ? (p.child ? "no parent" : "child of")
    : folds.find((fold) => fold.focused)?.open ? "close" : "open";
  return {
    step: "preview", soul: p.soul?.name ?? null, status: p.status, facts, problem,
    fields: { name: { text: p.name, focused: focus === "name" }, child: { offered: p.anchor !== null, on: p.child, label: p.anchor?.instance ?? null, focused: focus === "child" } },
    focus, folds, enter, ready, top: p.top,
  };
}
