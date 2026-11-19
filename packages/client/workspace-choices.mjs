/** The words a workspace switcher shows for a view (UI spec, #482; #855, 3a): its name, its one muted
 * line, how many of its deployments are not live, its tooltip, and whether a typed filter keeps it.
 * From what panel-views.mjs `workspaceChoices` answers. Words only: a client draws them (the Desktop's
 * menu is packages/desktop/renderer/workspace-switcher.mjs).
 *
 * No state: arguments in, values out, and no argument is changed.
 * A page loads this module: it imports no Node builtin, and must not. */
import { pathTail } from "./deployment-label.mjs";

/** A choice id that is this computer's folder (a deployment from an older server, an unattached
 * one): its path may be shown, as a tooltip. Any other id (a view's `ws:…`, a remote's `remote:…`)
 * is never shown (#482). */
export const isLocalPath = (id) => typeof id === "string" && id.startsWith("/");
const short = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max ? value : "";

const machinesOf = (choice) => Array.isArray(choice?.machines) ? choice.machines.filter((m) => short(m)) : [];

/** The machines a choice's deployments are on, as one line (UI spec, #482): "This Mac · builder", from
 * the server's `machines`. Never a path or an id: without `machines` (an older server), nothing. */
export function workspaceChoicePlace(choice) {
  return machinesOf(choice).join(" · ");
}

/** Each choice's name, in order. Two choices of one name are told apart by a suffix. */
export function workspaceChoiceLabels(choices) {
  const base = choices.map((choice) => choice.name
    || (isLocalPath(choice.id) ? String(choice.id).split("/").filter(Boolean).at(-1) : "")
    || "Workspace");
  const counts = new Map();
  for (const name of base) counts.set(name, (counts.get(name) || 0) + 1);
  return choices.map((choice, index) => {
    if (counts.get(base[index]) === 1) return base[index];
    // Two choices of one name: their workspace keys tell them apart, else a folder's last two
    // segments or the machines; never a ws: or remote: id, never a full path.
    const which = short(choice.key, 512) || (isLocalPath(choice.id) ? pathTail(choice.id, 2) : workspaceChoicePlace(choice));
    const suffix = [short(choice.team?.name), which].filter(Boolean).join(" · ");
    return suffix ? `${base[index]} — ${suffix}` : base[index];
  });
}

/** The tooltip of a choice: its deployments' labels (machine and short path) when the server sends
 * them, else a local folder's path; never an id. */
function choiceTooltip(choice) {
  const deployments = Array.isArray(choice?.deployments) ? choice.deployments : [];
  const labels = Array.isArray(choice?.deploymentLabels) && choice.deploymentLabels.length === deployments.length
    && choice.deploymentLabels.every((l) => short(l, 512)) ? choice.deploymentLabels : [];
  return labels.join(", ") || (isLocalPath(choice?.id) ? choice.id : "");
}

/** The section a switcher lists unattached views under (#482, expert decision Q4). */
export const UNMATCHED_SECTION = "Not matched to a workspace";

/**
 * What a switcher says for each choice, in the same order. Every entry is its name and ONE muted line
 * (UI spec, #482): a view's machines, an unattached view's machine and short reason.
 *
 *   id           the choice's id
 *   label        its name (`workspaceChoiceLabels`)
 *   place        the muted line. A matched view: its machines, joined by " · ". An unattached one: its
 *                machine, unless the label already is that machine (a remote group is named by its
 *                server), then its short reason, joined the same way
 *   notLive      for a matched view, how many of its deployments are not live when that is a positive
 *                integer; else 0
 *   notLiveText  "1 deployment not live", "N deployments not live", or ""
 *   unattached   whether no workspace identity matched it: such a view goes under UNMATCHED_SECTION
 *   tooltip      its deployments' labels when there is one label per deployment, else a local folder's
 *                path, else ""
 *   deployment   for an unattached view, its first deployment's id (where its full reason and its fix
 *                are shown); else null
 *
 * @param {Array<object>} choices what `workspaceChoices` (panel-views.mjs) answers
 */
export function workspaceChoiceRows(choices) {
  const labels = workspaceChoiceLabels(choices);
  return choices.map((choice, index) => {
    const label = labels[index], unattached = !!choice.unattached;
    const place = unattached
      // The machine, unless the entry is already named by it (a remote group is named by its server).
      ? [machinesOf(choice)[0] === label ? "" : machinesOf(choice)[0] || "", short(choice.short)].filter(Boolean).join(" · ")
      : workspaceChoicePlace(choice);
    const notLive = !unattached && Number.isInteger(choice.notLive) && choice.notLive > 0 ? choice.notLive : 0;
    return { id: choice.id, label, place, notLive,
      notLiveText: notLive ? `${notLive} ${notLive === 1 ? "deployment" : "deployments"} not live` : "",
      unattached, tooltip: choiceTooltip(choice),
      deployment: (unattached && Array.isArray(choice.deployments) ? choice.deployments[0] : null) || null };
  });
}

/** A switcher's filter: whether a row is kept for what was typed. The query is trimmed and lower-cased
 * here; it is looked for in the row's label and place, joined by a space and lower-cased, so what is not
 * shown (a tooltip, a full reason) is never matched. No query keeps every row. */
export function choiceMatches(row, query) {
  const wanted = String(query ?? "").trim().toLocaleLowerCase();
  return !wanted || `${row.label} ${row.place}`.toLocaleLowerCase().includes(wanted);
}
