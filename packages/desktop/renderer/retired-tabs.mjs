/* oats desktop — which terminal tabs a roster answer shows retired (#1237). Pure: the shell closes the
   ids it answers (shell.mjs `closeRetiredTabs`), on an owned, observed roster answer only.

   A terminal tab is bound to ONE incarnation of an instance: its key (instance-tree-view.mjs
   `terminalKey`: workspace + home) and the row's `createdAt`, the kernel's incarnation of a home,
   recorded on the tab at open (`terminalOrigin`) with the row's deployment and server. A roster row
   with the same home and another `createdAt` is a different instance: it never shows in, or activates,
   the old tab (`tabShowsRow`).

   A tab is retired when the answer proves it, and only then (fail closed: keep the tab). (R) and (G) are a row's
   own facts, so they count only from a current read of that row's deployment (the facts of (A) below): a row held
   from an unreached, kept or unasked read keeps whatever it was last read with.
   (R) Replaced: every row with the tab's identity reports a `createdAt` string, and none is the one the
       tab recorded. Null or absent on either side is no evidence (an older kernel, a saved route).
   (G) Gone on its host: every row with the tab's identity is a remote row the kernel reports
       `missingRemotely: true` (the host was reached and did not list it; lib/servers.mjs).
   (P) On a session provider: every row with the tab's identity runs on a session provider (provider-row.mjs:
       its `backend` is a provider's name, "bb" say). Such a row has no tmux target and no terminal, so a
       terminal tab left on it shows nothing of it: it closes, quietly, as a retired one does.
   (A) Absent from a good read: no row has the tab's identity, and this answer carries a successful,
       current read of the deployment the tab came from. The panel facts that prove it
       (client/panel-views.mjs `deploymentInfo` / `deploymentEntry`, `panelData`):
       - exactly one `deployments[]` entry has the tab's recorded deployment id, of the tab's kind
         (`local: true` for a local tab, `local: false` for a remote one);
       - it is `reachable: true`: a local deployment whose observation is `observed` (not pending, not
         unavailable), a remote group whose probe reached its host this read;
       - it is not `stale`: no failed re-read kept the last observation (local), and a filtered read
         asked for it (remote, #1124: a kept group is stale);
       - as the view's primary, the panel carries no kept `error` (deployment-facts.mjs `keptFailure`);
       - no row of that deployment says `serverUnreached`.
       Anything else — a deployment that left the view or that a rehome moved to an id the tab did not
       record, a deployment the read did not ask, a kept failure, an unreached server, a pending or
       empty answer — proves nothing.
   Never evidence: the PTY ending (Stop ends it too), `running: false`, `retirePending`, the kernel's
   `retire` in any state, `rollbackIncomplete`, `addressable: false`, a reconnect failure, the Desktop's own
   retire receipt or its retire in flight (#1247: the shell judges the kernel's answer, never `shownRows`'
   copies, so a row held as Retiring… only by this window closes nothing). */
import { terminalKey } from "./instance-tree-view.mjs";
import { keptFailure } from "../../client/deployment-facts.mjs";
import { sessionProvider } from "../../client/instance-presentation.mjs";

const text = v => typeof v === "string" && v.length > 0;

/** What a terminal tab records of the row it opened, once: its incarnation, deployment and server. */
export function terminalOrigin(row) {
  const deployment = typeof row?.deployment === "string" ? row.deployment : row?.deployment?.id;
  return Object.freeze({
    incarnation: text(row?.createdAt) ? row.createdAt : null,
    deployment: text(deployment) ? deployment : null,
    server: text(row?.server) ? row.server : null,
  });
}

/** Two incarnations differ only when both are known. */
export const otherIncarnation = (a, b) => text(a) && text(b) && a !== b;

/** Whether a roster row is the instance a terminal tab shows: its key, and not another incarnation. */
export function tabShowsRow(tab, workspace, row) {
  return tab?.kind === "terminal" && !!row && tab.key === terminalKey(workspace, row)
    && !otherIncarnation(tab.origin?.incarnation, row.createdAt);
}

const deploymentOf = row => typeof row?.deployment === "string" ? row.deployment : row?.deployment?.id;

/** True when this answer holds a successful, current read of deployment `id` (`remote`: another machine's). */
function currentRead(panel, id, remote) {
  if (!text(id)) return false;
  const entries = (Array.isArray(panel.deployments) ? panel.deployments : []).filter(d => d?.id === id);
  if (entries.length !== 1) return false;
  const [entry] = entries;
  if (entry.reachable !== true || entry.stale === true) return false;
  if (entry.local !== !remote) return false;
  if (entry.primary === true && keptFailure(panel)) return false;
  return !panel.instances.some(row => row?.serverUnreached === true && deploymentOf(row) === id);
}

/** A row's own evidence (R, G or P), only from a current read of its deployment: a row held from an unreached,
 * kept or unasked read keeps the facts it was last read with, which prove nothing now. */
function rowSaysGone(panel, tab, row) {
  if (row.serverUnreached === true || !currentRead(panel, deploymentOf(row), text(row.server))) return false;
  return otherIncarnation(tab.origin?.incarnation, row.createdAt) || (text(row.server) && row.missingRemotely === true)
    || sessionProvider(row) !== null;
}

/** The ids of the open terminal tabs of the panel's workspace that this panel answer shows retired.
 * `tabs`: the shell's Map (or any iterable) of [id, tab]; a terminal tab carries `key`, `workspace`
 * and `origin` (`terminalOrigin`). */
export function retiredTabs(tabs, panel) {
  const workspace = panel?.workspace?.id;
  if (!text(workspace) || !Array.isArray(panel.instances)) return [];
  const retired = [];
  for (const [id, tab] of tabs || []) {
    if (tab?.kind !== "terminal" || tab.workspace !== workspace || !text(tab.key)) continue;
    const rows = panel.instances.filter(row => row && typeof row === "object" && terminalKey(workspace, row) === tab.key);
    const gone = rows.length
      ? rows.every(row => rowSaysGone(panel, tab, row))
      : currentRead(panel, tab.origin?.deployment, text(tab.origin?.server));
    if (gone) retired.push(id);
  }
  return retired;
}
