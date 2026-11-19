/** Home's board and its flat list of agents (Desktop UI rework, slice 2): the groupings both clients draw, so the
 * TUI can render the same Home later. Pure, no DOM, never throws. Rows are `oats status --json` instance rows as
 * the roster holds them; nothing here reorders the roster (needs-input-preserves-liveness-and-recognition: the
 * urgency order lives on Home only).
 *
 *   homeBoard(rows, { stale }) -> { needsYou: [{ row, claim }], running: [row] }
 *     needsYou: every row with a claim it may show (waiting-on-you.mjs `waitingClaim`, the one liveness gate,
 *               `stale(row)` the roster's held-stale rule), newest claim first (its `since`), then the roster's
 *               order. running: every other live row (`running === true`, no reported state but `running`, a
 *               reached server), newest spawn first (instance-tree.mjs `rosterOrder`). There is no working/idle
 *               fact yet (the activity contract is not built), and none is inferred
 *               (instance-activity-is-reported-not-inferred): a live row is "running". Stopped and unknown rows
 *               aren't on the board (D11). The "New" group (stopped or finished since you last looked) has no
 *               fact to read, so it isn't here.
 *   homeAgents(rows, { pins }) -> rows: every agent, running or stopped, in the roster's order: pinned first where
 *               the CLI reports pins (`pins`, instance-tree.mjs `rowPinned`, #1974), then newest spawn first.
 *   startedBy(row) -> string | null: who started it, the row's attributed human (attributed-human.mjs), else
 *               its parent's name (`parentInstance`), else null. */
import { waitingClaim } from './waiting-on-you.mjs';
import { rosterOrder, rowPinned } from './instance-tree.mjs';
import { attributedHumanData } from './attributed-human.mjs';
import { instanceDisplayName } from './instance-display-name.mjs';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((row) => record(row) && typeof row.instance === 'string' && row.instance) : []);
const since = (claim) => { const t = Date.parse(claim.since); return Number.isFinite(t) ? t : -Infinity; };
const live = (row) => row.running === true && row.serverUnreached !== true && (row.runtimeState == null || row.runtimeState === 'running');

export function homeBoard(rows, { stale = () => false } = {}) {
  const needsYou = [], running = [];
  for (const row of rowsOf(rows)) {
    const claim = waitingClaim(row, { stale: stale(row) === true });
    if (claim) needsYou.push({ row, claim });
    else if (live(row)) running.push(row);
  }
  needsYou.sort((a, b) => since(b.claim) - since(a.claim) || rosterOrder(a.row, b.row));
  running.sort(rosterOrder);
  return { needsYou, running };
}

export function homeAgents(rows, { pins = false } = {}) {
  const pinned = (row) => (rowPinned(row, pins) ? 1 : 0);
  return rowsOf(rows).sort((a, b) => pinned(b) - pinned(a) || rosterOrder(a, b));
}

export function startedBy(row) {
  const human = attributedHumanData(row?.attributedHuman);
  if (human) return human;
  const parent = typeof row?.parentInstance === 'string' && row.parentInstance ? row.parentInstance : null;
  if (!parent) return null;
  return instanceDisplayName(parent) || parent;
}
