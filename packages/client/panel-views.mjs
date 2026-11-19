/** The deployments a client serves and the workspace views over them (#482, workspace-views.mjs; #855, 1d):
 * what the switcher lists, what a panel holds, and which deployment a request is addressed to.
 * A view is one per matched workspace identity, plus one per unattached deployment under that
 * deployment's own id. Everything is built per call from what the client holds; never a CLI read.
 *
 * No state. Every function that reads what a client holds takes it as its first argument, `held`,
 * reads it and never changes it. The client builds one per call from its own store:
 *
 *   held = {
 *     ctxs,              // string[]: this machine's deployments, in served order
 *     snapshot,          // { byWs: Map<deployment id, entry | remote panel> } (deployment-panel.mjs entries)
 *     remoteGroups,      // the last readable remote roster's groups (remote-roster.mjs)
 *     remembered,        // the remembered remote identities: an object with get(id), note(id), all()
 *     rosterAnswered,    // boolean: a roster answer arrived under the current CLI
 *     rosterFailure,     // string | null: the roster read's failure while no answer has arrived
 *     cli,               // the kernel record (cli-locator.mjs)
 *     observing,         // keyed by deployment id (`has`): a read in flight
 *     remoteCollecting,  // boolean: the remote roster is being read
 *     home,              // string: the user's home directory, for the short label
 *     at,                // string: the ISO time of this call
 *     learned,           // optional: Map<deployment path, identity read> (deployment-identity.mjs
 *                        // `cliDeploymentIdentity` answers) of this computer's deployments, read before
 *                        // they were observed: see `deploymentInfo` and `listedViews`
 *   }
 *
 * These functions read no clock: the one time they stamp is `held.at`, and the same `held` gives the
 * same answer. A remote deployment's panel is remote-roster.mjs `remotePanel`, made at `held.at`; what
 * a remote roster's answer becomes is that module's `remoteRosterState`, whose answer is the three
 * roster values of `held`.
 *
 * `remembered` is the client's own store, passed in: this module calls its three reading methods and
 * keeps nothing. `note(id)` answers the sentence left for a machine that moved to another workspace,
 * or null. The store's writing method is never called from here.
 *
 * A function that reaches a sentence or a label takes the client's terms (client-terms.mjs) after its
 * required arguments and before its optional ones, and throws without them.
 *
 * Not for a page: this module imports `node:path`, and so does deployment-panel.mjs. */
import { basename } from 'node:path';
import { remoteWorkspace, remotePanel } from './remote-roster.mjs';
import { readIdentity, attachment, buildViews, deploymentReason, deploymentReasonParts } from './workspace-views.mjs';
import { shortPath, deploymentLabel } from './deployment-label.mjs';
import { deploymentUnavailableText, keptFailure } from './deployment-facts.mjs';
import { publicDeployment } from './deployment-panel.mjs';
import { teamMembers } from './team-members.mjs';
import { requireTerms } from './client-terms.mjs';
import { ROSTER_WORKSPACE_KEY } from './cli-adapter.mjs';
import { waitingClaim } from './waiting-on-you.mjs';
import { sameWorkDeclared, withSameWorkGate } from './same-work.mjs';

/** Roots come ONLY from the kernel's observed `status.root`; before (or
 * without) an observation there is nothing to act on. No layout guess. */
export function workspaceEntry(held, ctx) {
  const deployment = held.snapshot.byWs.get(ctx)?.deployment;
  const observed = deployment?.status === "observed";
  return { id: ctx, name: (observed && deployment.workspace?.name) || basename(ctx) || ctx, scope: ctx, team: null,
    roots: observed ? [deployment.root] : [] };
}
/** Every served deployment, in served order: the local deployments, then the
 * remote roster groups, then (only while there is no roster answer at all) the remembered remote
 * groups, which have no rows. An id here is a deployment id: every instance-addressed route
 * resolves only these. */
export function deployments(held) {
  return [...held.ctxs.map((ctx) => workspaceEntry(held, ctx)), ...held.remoteGroups.map(remoteWorkspace), ...rememberedGroups(held).map(remoteWorkspace)];
}

/** Remembered remote groups shown only while no roster answer exists: not reached, no rows (Q3). */
export function rememberedGroups(held) {
  if (held.rosterAnswered) return [];
  const listed = new Set(held.remoteGroups.map((g) => g.id));
  return held.remembered.all().filter((e) => !listed.has(e.id)).map((e) => ({
    id: e.id, server: e.server, label: e.label, registrationPresent: true, remembered: true,
    target: { workspace: e.path }, probe: { ok: false, error: { code: "E_REMOTE_ROSTER", message: held.rosterFailure || "no roster answer" } },
    agentsRoot: undefined, workspace: null, souls: [], instances: [], retireFailures: [],
  }));
}
/** Whether a kernel record (cli-locator.mjs) reads other machines: an accepted CLI whose `remote` lists
 * `roster`. Without it a client makes no roster read (remote-roster.mjs `remoteRosterState`: "gated"). */
export const cliReadsRemotes = (cli) => !!cli.ok && !!cli.remote?.includes("roster");
const identityFeature = (held) => !!held.cli.features?.includes("workspace-identity");
/** What a projected `workspace` object (deployment-data.mjs) says of the identity: readIdentity's
 * classification, `feature` when the CLI reports no identities, `invalid` when the projection marked it. */
const identityRead = (held, workspace) => (!identityFeature(held) ? { status: "feature" }
  : workspace?.identityInvalid ? { status: "invalid" } : readIdentity(workspace));
/** The identity read learned of this computer's deployment `id` before it was observed (`held.learned`):
 * the answer when the read answered, else null (not read, or the read failed). */
const learnedOf = (held, id) => { const read = held.learned?.get?.(id); return read?.ok === true ? read : null; };
/** One deployment's identity, attachment, machine label and reason. */
export function deploymentInfo(held, d, terms) {
  requireTerms(terms, 'deploymentInfo');
  if (!d.remote) {
    const entry = held.snapshot.byWs.get(d.id), observed = entry?.deployment;
    const live = observed?.status === "observed";
    // A failed re-read kept the last observation (deployment-panel.mjs `failedEntry`): its identity still places
    // it in its view, but it is stale, not live, and says why. Still reachable: this computer's own deployment.
    // Whether one is kept is deployment-facts.mjs `keptFailure`'s to say, never a test of the message.
    const kept = live ? keptFailure(entry) : null;
    // Not observed (yet, or its read failed): the identity an identity read learned of it, when one did, places it
    // in its view (`identityFrom: "learned"`); it stays not live, with its reading or unavailable sentence.
    const learned = live ? null : learnedOf(held, d.id);
    const read = live ? identityRead(held, observed.reachable) : learned ? identityRead(held, learned.workspace) : { status: "none" };
    const identity = read.status === "identity" ? read.identity : null;
    const attach = attachment(identity);
    // Not observed (yet): the reading or unavailable sentence, never a silent empty.
    const unavailable = live ? null : deploymentUnavailableText(observed || { status: "pending" }, terms);
    return { id: d.id, local: true, machine: terms.thisMachine, path: d.id, label: shortPath(d.id, { home: held.home }), name: d.name,
      live: live && !kept, reachable: live, ...(kept ? { stale: true } : {}), identityFrom: identity ? (live ? "reported" : "learned") : null, identity, attach,
      teamLabel: identity?.defaultTeam?.label ?? null,
      ...reasonFields(deploymentReasonParts({ local: true, identityStatus: read.status, attach, ref: identity?.ref, unavailable,
        ...(kept ? { readError: kept.message, readErrorOrigin: kept.origin } : {}) }, terms)),
      note: attach.note === "standalone" ? deploymentReason({ local: true, attach: { unattached: "standalone" } }, terms) : null };
  }
  const g = d.group, machine = g.label || g.server;
  const reached = g.probe?.ok === true;
  // A group a filtered roster read kept as last read (#1124, `held.keptReadAt`: remote-roster.mjs `keptReadTimes`):
  // a machine reached then is stale now, as this computer's deployment is after a failed re-read, never live.
  const kept = reached && !!held.keptReadAt?.get?.(g.id);
  let read = reached ? (identityFeature(held) ? readIdentity(g.workspace) : { status: "feature" }) : { status: "none" };
  let identityFrom = read.status === "identity" ? "reported" : null;
  if (!reached && (g.remembered || held.remembered.get(g.id))) {
    const memory = held.remembered.get(g.id);
    if (memory) { read = { status: "identity", identity: memory.workspace }; identityFrom = "remembered"; }
  }
  const identity = read.status === "identity" ? read.identity : null;
  const attach = attachment(identity);
  const reason = reasonFields(deploymentReasonParts({ local: false, machine, sshHost: g.target?.sshHost, probe: g.probe, identityStatus: read.status, attach,
    ref: identity?.ref, cliReadsRemotes: cliReadsRemotes(held.cli), rosterError: g.remembered ? held.rosterFailure : null }, terms));
  const moved = held.remembered.note(g.id);
  const standalone = attach.note === "standalone" ? deploymentReason({ local: false, attach: { unattached: "standalone" } }, terms) : null;
  return { id: d.id, local: false, machine, path: g.target?.workspace || "", label: shortPath(g.target?.workspace || ""), name: d.name,
    live: reached && !kept, reachable: reached, ...(kept ? { stale: true } : {}), identityFrom, identity, attach, teamLabel: identity?.defaultTeam?.label ?? null,
    ...reason, note: [moved, standalone].filter(Boolean).join(" ") || null };
}
/** A reason's parts as a deployment's fields: `reason` (the full sentence), `short` and `fix` (UI spec, #482). */
export function reasonFields(parts) {
  return parts ? { reason: parts.detail, short: parts.short, fix: parts.fix } : { reason: null, short: null, fix: [] };
}
/** buildViews' views over `infos`, each unattached one with its deployment's reason, short reason and ref. */
function viewsOver(infos) {
  return buildViews([...infos.values()]).map((v) => {
    const unattachedReason = v.unattached ? infos.get(v.primary)?.reason ?? null : null;
    const unattachedShort = v.unattached ? infos.get(v.primary)?.short ?? null : null;
    const ref = v.unattached ? infos.get(v.primary)?.identity?.ref ?? null : null;
    return { ...v, ...(unattachedReason ? { reason: unattachedReason } : {}), ...(unattachedShort ? { short: unattachedShort } : {}), ...(ref ? { ref } : {}) };
  });
}
/** The views and the per-deployment facts they rest on: `{ views, infos: Map<deploymentId, info> }`. */
export function viewModel(held, terms) {
  requireTerms(terms, 'viewModel');
  const infos = new Map(deployments(held).map((d) => [d.id, deploymentInfo(held, d, terms)]));
  return { views: viewsOver(infos), infos };
}

/** Why an identity read of a listed deployment failed, as reason parts: `Timed out` for the read's time limit
 * (a read that never began before its caller's budget ran out is answered the same), else `Not read`; the
 * sentence is the unavailable one (deployment-facts.mjs), the kernel's words set apart when it gave them. */
function identityFailure(reason, terms) {
  return { short: reason?.code === "E_CLI_TIMEOUT" ? "Timed out" : "Not read", detail: deploymentUnavailableText({ status: "unavailable", reason: reason || {} }, terms), fix: [] };
}
/** One row of this computer's deployments list (deployment-list.mjs: `{ path, name }`) that the client does not
 * serve, as a switcher matches it: an info of `deploymentInfo`'s shape, never live or reachable, `listed: true`,
 * named by the row (its folder's name, a local name to buildViews), with the identity an identity read learned
 * of it (`held.learned`) and `read`: "pending" (no answer yet), "read" or "failed". Its reason says why it is not
 * matched: the read's failure, or the shared reason of an identity that attaches to no workspace; none while it
 * is pending or when it attaches. */
export function listedInfo(held, row, terms) {
  requireTerms(terms, 'listedInfo');
  const answer = held.learned?.get?.(row.path) ?? null, learned = answer?.ok === true ? answer : null;
  const read = learned ? identityRead(held, learned.workspace) : { status: "none" };
  const identity = read.status === "identity" ? read.identity : null;
  const attach = attachment(identity);
  const parts = answer === null ? null : !learned ? identityFailure(answer.reason, terms)
    : deploymentReasonParts({ local: true, identityStatus: read.status, attach, ref: identity?.ref }, terms);
  return { id: row.path, local: true, listed: true, machine: terms.thisMachine, path: row.path, label: shortPath(row.path, { home: held.home }), name: row.name,
    live: false, reachable: false, identityFrom: identity ? "learned" : null, identity, attach, teamLabel: identity?.defaultTeam?.label ?? null,
    read: answer === null ? "pending" : learned ? "read" : "failed", ...reasonFields(parts), note: null };
}
/** The switcher's views (#482): `viewModel`'s, with this computer's listed deployments the client does not serve
 * matched in by the same rule (buildViews, over the served deployments first, then these). `listed`: the list's
 * rows (`{ path, name }`), in its order; a row the client serves is passed over. A listed deployment whose
 * identity attaches joins its workspace's view, or makes one; the others are `unmatched`, in order, each
 * `listedInfo`'s answer. `{ views, infos, unmatched }`: `infos` holds the served deployments' and the matched
 * listed ones'. Only a switcher reads this: a listed deployment is in no panel and no route. */
export function listedViews(held, listed, terms) {
  requireTerms(terms, 'listedViews');
  const model = viewModel(held, terms);
  const offered = (Array.isArray(listed) ? listed : []).filter((row) => !model.infos.has(row?.path)).map((row) => listedInfo(held, row, terms));
  const infos = new Map([...model.infos, ...offered.filter((info) => !info.attach.unattached).map((info) => [info.id, info])]);
  return { views: viewsOver(infos), infos, unmatched: offered.filter((info) => info.attach.unattached) };
}
/** The view a selector names: a view id, or a deployment id (answered with the view that holds it, so
 * a selection saved before views opens its view). No selector means the first view. `model` is a
 * view model already built for this call (`viewModel`); without one, it is built here. */
export function viewFor(held, wsId, terms, model) {
  requireTerms(terms, 'viewFor');
  if (model === undefined) model = viewModel(held, terms);
  if (!wsId) return model.views[0] || null;
  return model.views.find((v) => v.id === wsId) || model.views.find((v) => v.deployments.includes(wsId)) || null;
}
/** A deployment-level surface (header, capabilities, sync, automations, schedules, teams configuration,
 * brain, launch configurations, spawn catalog): a deployment id as itself, a view id as that view's
 * PRIMARY deployment (its first local one, else its first). Never used for an instance-addressed route,
 * which resolves deployment ids only (`deployments(held).find`), so a view id there is refused. */
export function deploymentFor(held, wsId, terms) {
  requireTerms(terms, 'deploymentFor');
  const exact = wsId ? deployments(held).find((w) => w.id === wsId) : null;
  if (exact) return exact;
  const view = viewFor(held, wsId, terms);
  return view ? deployments(held).find((w) => w.id === view.primary) || null : null;
}
/** A body that names an instance home (capabilities, launch configurations, schedules) addresses that
 * instance: only an exact deployment id resolves it, never a view id. Anything else is deployment-level. */
const namesInstance = (request) => request?.selector?.home !== undefined || request?.spec?.home !== undefined;
export function surfaceDeployment(held, wsId, request, terms) {
  requireTerms(terms, 'surfaceDeployment');
  if (!wsId) return undefined; // these routes name their workspace: no selector is no workspace, never the first
  return namesInstance(request) ? deployments(held).find((w) => w.id === wsId) : deploymentFor(held, wsId, terms);
}
/** The forge roster's context for a view (or a deployment id, read as its view): the union of its
 * local deployments' rows and clones, under the view's id. */
export function viewForgeContext(held, wsId, terms) {
  requireTerms(terms, 'viewForgeContext');
  const view = viewFor(held, wsId, terms);
  if (!view) return { workspace: undefined, cli: held.cli, instances: [], clones: [] };
  const local = view.deployments.filter((id) => held.ctxs.includes(id));
  const observed = local.map((id) => held.snapshot.byWs.get(id)).filter(Boolean);
  return { workspace: { id: view.id, name: view.name, remote: local.length === 0 }, cli: held.cli,
    instances: observed.flatMap((o) => o.instances || []), clones: observed.flatMap((o) => o.deployment?.workspaceStatus?.clones || []) };
}
/** One deployment's own rows (never its view's union): what an instance-addressed request may admit. */
export function deploymentRows(held, ws) {
  return deploymentPanel(held, ws).instances || [];
}
/** The ids a client may let a caller select: every view id and every deployment id. */
export function isServed(held, id, terms) {
  requireTerms(terms, 'isServed');
  const model = viewModel(held, terms);
  return model.views.some((v) => v.id === id) || model.infos.has(id);
}
/** The members of a view's deployments only, each tagged with its deployment (Q5; team-members.mjs);
 * null for a selector that names no view. */
export function teamMembersFor(held, wsId, terms) {
  requireTerms(terms, 'teamMembersFor');
  const model = viewModel(held, terms);
  const view = viewFor(held, wsId, terms, model);
  if (!view) return null;
  const members = view.deployments.map((id) => deployments(held).find((w) => w.id === id)).filter(Boolean);
  return teamMembers({
    deployments: members.filter((d) => !d.remote).map((d) => ({ deployment: deploymentTag(model.infos.get(d.id)), instances: held.snapshot.byWs.get(d.id)?.instances || [] })),
    groups: members.filter((d) => d.remote).map((d) => ({ group: d.group, deployment: deploymentTag(model.infos.get(d.id)),
      panel: held.snapshot.byWs.get(d.id) || remotePanel(d.group, held.at) })) });
}

/** A workspace's own machines (#517): the view's key, the deployment every
 * machine call runs in and its messaging slot. The key is the one the view's primary local deployment
 * reports (keyFrom "workspace" only; a matched view's deployments all share it); without one, or with no
 * local deployment, `key` is null and `reason` says which. null for a selector that names no view. */
export function machineScope(held, wsId, terms) {
  requireTerms(terms, 'machineScope');
  const model = viewModel(held, terms);
  const view = viewFor(held, wsId, terms, model);
  if (!view) return null;
  const local = view.deployments.map((id) => model.infos.get(id)).find((info) => info?.local);
  if (!local) return { key: null, deployment: null, messaging: null, reason: "no-local" };
  const identity = local.identity;
  const messaging = held.snapshot.byWs.get(local.id)?.deployment?.workspaceStatus?.defaults?.slots?.messaging?.name ?? null;
  if (identity?.keyFrom !== "workspace" || typeof identity.key !== "string" || !identity.key) return { key: null, deployment: local.id, messaging, reason: "no-key" };
  return { key: identity.key, deployment: local.id, messaging };
}

/** The workspace keys the roster read asks for (#1124, the CLI's feature roster-workspace-key): one per
 * distinct usable key of the views the open windows show (`windowViews`: each window's view id, or null
 * for a window bound to none), sorted; or null for the unfiltered read. The key of a view:
 *
 *   a matched view                     its key (every deployment of it reports that key)
 *   an unattached view                 its one deployment's key, reported or (a machine not reached)
 *                                      remembered, member-derived included: a registration records the
 *                                      key the host reports, whatever its keyFrom
 *
 * A key that is null, or one the kernel would refuse (cli-adapter.mjs `ROSTER_WORKSPACE_KEY`), is no
 * registration's: a view without a usable key adds none, and when that view holds another machine's
 * deployment, whose registration then cannot be named, the read is unfiltered so that machine is still
 * read. Unfiltered too: no window set yet (`windowViews` not an array), no roster answer yet (the first
 * read holds every machine), a window showing the switcher (it lists every workspace), and a view id
 * no view has (a window ahead of what is served). No window, or no usable key: `[]`, which a caller
 * reads unfiltered as well. */
export function rosterWorkspaceKeys(held, windowViews, terms) {
  requireTerms(terms, 'rosterWorkspaceKeys');
  if (!Array.isArray(windowViews) || !held.rosterAnswered) return null;
  const model = viewModel(held, terms);
  const keys = new Set();
  for (const id of windowViews) {
    if (id === null) return null;
    const view = model.views.find((v) => v.id === id);
    if (!view) return null;
    const key = view.key ?? model.infos.get(view.primary)?.identity?.key ?? null;
    if (typeof key === 'string' && ROSTER_WORKSPACE_KEY.test(key)) keys.add(key);
    else if (view.deployments.some((d) => !model.infos.get(d)?.local)) return null;
  }
  return [...keys].sort();
}

/** A deployment as the panel and the rows name it. */
export const deploymentTag = (info) => ({ id: info.id, machine: info.machine, path: info.path });
/** A deployment's entry in the panel's `deployments` list (roster-sections.mjs `deploymentState` reads one). */
export function deploymentEntry(info, primary) {
  return { ...deploymentTag(info), label: info.label, local: info.local, reachable: info.reachable,
    identityFrom: info.identityFrom, primary: info.id === primary, ...(info.stale ? { stale: true } : {}),
    ...(info.reason ? { reason: info.reason } : {}), ...(info.short ? { short: info.short } : {}),
    ...(info.reason && info.fix?.length ? { fix: [...info.fix] } : {}), ...(info.note ? { note: info.note } : {}) };
}

/** One deployment's own panel, as served before views. Each row carries whether its host declares
 * instance-same-work (#1577), stamped here and nowhere else (same-work.mjs `withSameWorkGate`): `held.cli` for
 * this computer's rows, and the group's host too for another machine's. */
export function deploymentPanel(held, ws) {
  // Another machine's panel never says who made its `error`: the key is removed here whatever the panel carried.
  // A kept group's panel is made at the time it was read (#1124): a filtered read never makes it look newer.
  if (ws?.remote) {
    const { errorOrigin: _sent, ...panel } = remotePanel(ws.group, held.keptReadAt?.get?.(ws.group.id) ?? held.at);
    const declared = sameWorkDeclared(held.cli, ws.group);
    return { ...panel, instances: panel.instances.map((row) => withSameWorkGate(row, declared)), observedAt: null, refreshing: held.remoteCollecting };
  }
  const observed = ws ? held.snapshot.byWs.get(ws.id) : null;
  const declared = sameWorkDeclared(held.cli);
  const instances = (observed?.instances || []).map((row) => withSameWorkGate(row, declared)), kept = keptFailure(observed);
  return {
    workspace: ws ? { id: ws.id, name: ws.name, team: null } : null,
    team: null,
    deployment: publicDeployment(observed?.deployment),
    generatedAt: observed?.generatedAt || held.at,
    // When the kernel observed the remotes this roster rests on, and whether a newer
    // observation of this deployment is running right now (a client labels stale data).
    observedAt: observed?.observedAt ?? null,
    refreshing: !!ws && held.observing.has(ws.id),
    running: instances.filter((i) => i.running).length,
    instances,
    // A failed re-read kept the last observation (deployment-panel.mjs `failedEntry`): its message, who made it
    // (`errorOrigin`, "kernel" or absent) and its bounded cause. `error` is a string exactly when one is kept.
    ...(kept ? { error: kept.message, ...(kept.origin ? { errorOrigin: kept.origin } : {}) } : {}),
    ...(observed?.errorCause ? { errorCause: observed.errorCause } : {}),
  };
}

/** Panel data is served from the latest observation and never blocks on a
 * CLI read: a client's views and its readiness probes stay responsive. A view's panel is its
 * primary deployment's panel (header, error, stamps) with the union of every deployment's rows,
 * each row tagged with its deployment, and the view's deployments listed. */
export function panelData(held, wsId, terms) {
  requireTerms(terms, 'panelData');
  const model = viewModel(held, terms);
  const view = viewFor(held, wsId, terms, model);
  const choices = workspaceChoices(held, terms, model);
  if (!view) return { ...deploymentPanel(held, null), workspaces: choices, deployments: [] };
  const members = view.deployments.map((id) => deployments(held).find((w) => w.id === id)).filter(Boolean);
  const panels = members.map((d) => [d, deploymentPanel(held, d)]);
  const [, primary] = panels.find(([d]) => d.id === view.primary) || panels[0];
  const instances = panels.flatMap(([d, p]) => (p.instances || []).map((row) => ({ ...row, deployment: deploymentTag(model.infos.get(d.id)) })));
  return {
    ...primary,
    // `primary`: the deployment a deployment-level request is addressed to (it echoes that deployment back).
    workspace: { ...primary.workspace, id: view.id, name: view.name, primary: view.primary, ...(view.key ? { key: view.key, teamId: view.team } : {}) },
    workspaces: choices,
    deployments: view.deployments.map((id) => deploymentEntry(model.infos.get(id), view.primary)),
    refreshing: panels.some(([, p]) => p.refreshing),
    running: instances.filter((i) => i.running).length,
    instances,
  };
}

/** Whether deployment `d` (a `deployments` entry) is live and current and one of its instance rows has a
 * claim a row may show (waiting-on-you.mjs `waitingClaim`). Its rows are its own panel's
 * (`deploymentPanel`: a local entry's rows, a remote group's), read from what the client holds. Not live
 * (`info.live`: a stale or kept-failure local entry, a kept or unreached remote group, a deployment not
 * observed) is never waiting: what it last said is unknown now. */
const deploymentWaits = (held, d, info) => info?.live === true && (deploymentPanel(held, d).instances || []).some((row) => waitingClaim(row) !== null);

/** The switcher's list: views, not deployments. Each names its deployments (a client lets a caller
 * select any of these ids); an unattached view keeps today's remote fields and says why. `waiting`
 * (boolean): some deployment of the view is live and has an instance that needs input
 * (`deploymentWaits`), from what the client holds, with no read: a view the client does not serve has no
 * row here, and so no dot. `model` is a view model already built for this call (`viewModel`); without
 * one, it is built here. */
export function workspaceChoices(held, terms, model) {
  requireTerms(terms, 'workspaceChoices');
  if (model === undefined) model = viewModel(held, terms);
  const served = deployments(held);
  return model.views.map((v) => {
    const primary = served.find((w) => w.id === v.primary);
    const remoteOnly = v.deployments.every((id) => !model.infos.get(id)?.local);
    // Without the CLI's workspace-identity feature nothing can match: every deployment keeps its own entry, listed as
    // before views, not as "not matched" (each deployment's own reason still says why).
    const unmatched = v.unattached && identityFeature(held);
    return { id: v.id, name: v.name, team: null, deployments: [...v.deployments],
      // The deployments' labels, in the same order, for a view that is not on screen ("This Mac · ~/acme").
      deploymentLabels: v.deployments.map((id) => deploymentLabel(model.infos.get(id), terms)),
      // The switcher's one-liner (UI spec, #482): the machines, in order and once each, and how many deployments aren't live.
      machines: [...new Set(v.deployments.map((id) => model.infos.get(id)?.machine).filter(Boolean))],
      notLive: v.deployments.filter((id) => !model.infos.get(id)?.live).length,
      waiting: v.deployments.some((id) => { const d = served.find((w) => w.id === id); return !!d && deploymentWaits(held, d, model.infos.get(id)); }),
      ...(v.key ? { key: v.key } : {}), ...(unmatched ? { unattached: true } : {}), ...(unmatched && v.reason ? { reason: v.reason } : {}), ...(unmatched && v.short ? { short: v.short } : {}), ...(unmatched && v.ref ? { ref: v.ref } : {}),
      ...(remoteOnly && primary?.remote ? { server: primary.server, remote: true } : {}) };
  });
}
