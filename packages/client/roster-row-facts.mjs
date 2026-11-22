/** The two text facts of an instance row in a sidebar roster (the Desktop UI rework, slice 1), shared so the
 * Terminal UI can draw the same row: line 1 the display name, line 2 `<soul>`, and ` · <machine>` only for a row of
 * another machine (slice 3d, the prototype's "reviewer · build-host": on this computer's rows it was noise).
 *
 *   rosterRowFacts(row, terms, { deployments, here }) -> { name, detail, soul, machine, local }
 *
 *   name     the instance name as words (instance-display-name.mjs), else the name as reported, else ''
 *   soul     the row's soul (`agent`), one display line, else null (a forgotten or malformed row)
 *   machine  where the row runs: the machine of the deployment the row is tagged with (`deployment.id` among
 *            `deployments`, a view's), else a remote server row's label (remote-address.mjs `serverLabel`), else
 *            this machine: its own name when the caller knows it (`here`, the host name the kernel reports for this
 *            machine), else `terms.thisMachine` (client-terms.mjs). A row of this machine's own deployment is this
 *            machine's too, whatever label the deployment carries. A view's row may carry `server` and a repository
 *            in `repoName`, so its deployment's machine comes first. Always a label: a row that names no machine is
 *            this machine's
 *   local    whether the row runs on this machine: its deployment is the local one, or it names no other machine
 *            (no machine-tagged deployment, no server); its `machine` is then `here`, or `terms.thisMachine`
 *   detail   `soul` for this machine's row, `soul · machine` for another machine's; the machine alone when no soul
 *            is known
 *
 * The facts only: no state, no reason, no repository, no harness. A row whose machine didn't answer keeps both
 * lines; its state is the dot's and its reason the row's description. Display only, never an identity: the real
 * name stays wherever it identifies the instance. Pure: no DOM, no IO. */
import { instanceDisplayName } from './instance-display-name.mjs';
import { serverLabel } from './remote-address.mjs';
import { displayLine, DETAIL_WITHHELD } from './display-text.mjs';
import { requireTerms } from './client-terms.mjs';

/** One display line, or null for nothing to show (absent, not text, withheld): the rule for every machine or soul
 * name the Desktop shows, here and on the status line (status-line.mjs `setMachine`). */
export const shownLine = (value) => {
  const line = typeof value === 'string' ? displayLine(value) : null;
  return line && line !== DETAIL_WITHHELD ? line : null;
};

/** The machine label of `row`, in `terms` (see the module's comment). */
export function rowMachine(row, terms, options = {}) {
  return rowPlace(row, terms, options).machine;
}

/** Where `row` runs: `{ machine, local }`, its label and whether it is this machine (see the module's comment). */
function rowPlace(row, terms, { deployments = [], here = null } = {}) {
  requireTerms(terms, 'rowMachine');
  const id = typeof row?.deployment?.id === 'string' ? row.deployment.id : null;
  const deployment = id && Array.isArray(deployments) ? deployments.find((d) => d?.id === id) : null;
  const server = typeof row?.server === 'string' && row.server ? shownLine(serverLabel(row)) ?? shownLine(row.server) : null;
  const thisMachine = shownLine(here) ?? terms.thisMachine;
  if (deployment?.local === true) return { machine: thisMachine, local: true };
  const other = shownLine(deployment?.machine) ?? server;
  return other ? { machine: other, local: false } : { machine: thisMachine, local: true };
}

/** The row's two lines and their parts. */
export function rosterRowFacts(row, terms, { deployments = [], here = null } = {}) {
  requireTerms(terms, 'rosterRowFacts');
  const instance = typeof row?.instance === 'string' ? row.instance : '';
  const name = instanceDisplayName(instance) || instance;
  const soul = shownLine(row?.agent);
  const { machine, local } = rowPlace(row, terms, { deployments, here });
  return { name, detail: soul && local ? soul : [soul, machine].filter(Boolean).join(' · '), soul, machine, local };
}
