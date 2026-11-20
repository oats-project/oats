/** Home's board and its flat list of agents (Desktop UI rework, slices 2 and 2b): the groupings both clients draw,
 * so the TUI can render the same Home later. Pure, no DOM, never throws. Rows are `oats status --json` instance rows
 * as the roster holds them; nothing here reorders the roster (needs-input-preserves-liveness-and-recognition: the
 * urgency order lives on Home only).
 *
 *   homeBoard(rows, { stale, pins }) -> { needsYou: [{ row, claim }], running: [row], counts: { agents, running, needYou, stopped, unknown } }
 *     needsYou: every row with a claim it may show (waiting-on-you.mjs `waitingClaim`, the one liveness gate,
 *               `stale(row)` the roster's held-stale rule), newest claim first (its `since`), then the roster's
 *               order.
 *     running:  every other live row, in the roster's order (pinned first where `pins`, as homeAgents): Home shows
 *               the first few, cropped and expandable (slice 2b, Amendment 1: Pepe, 2026-11-20).
 *     counts:   the summary line's numbers. agents: every row. needYou: the rows in needsYou. running: every other live row
 *               (`running === true`, no reported state but `running`, a reached server; a row on a session
 *               provider on `running === true` and a reached server alone). stopped: every other row
 *               that says `running: false`. unknown: the rest (no runtime fact, an unreached server, another
 *               reported state). Each row is counted once, so the four add up to agents. There is no working/idle
 *               fact yet (the activity contract is not built), and none is inferred
 *               (instance-activity-is-reported-not-inferred): a live row is "running".
 *   homeAgents(rows, { pins }) -> rows: every agent, running or stopped, in the roster's order: pinned rows first
 *               where the roster shows pins (`pins`: the CLI lists PIN_FEATURE; instance-tree.mjs `rowPinned`,
 *               #1974's shared order), then newest spawn first (`rosterOrder`).
 *   startedBy(row) -> string | null: who started it, the row's attributed human (attributed-human.mjs), else
 *               its parent's name (`parentInstance`), else null. */
import { waitingClaim } from './waiting-on-you.mjs';
import { rosterOrder, rowPinned } from './instance-tree.mjs';
import { attributedHumanData } from './attributed-human.mjs';
import { instanceDisplayName } from './instance-display-name.mjs';
import { sessionProvider } from './instance-presentation.mjs';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (rows) => (Array.isArray(rows) ? rows.filter((row) => record(row) && typeof row.instance === 'string' && row.instance) : []);
const since = (claim) => { const t = Date.parse(claim.since); return Number.isFinite(t) ? t : -Infinity; };
// A row on a session provider is live on `running === true` alone: its `runtimeState` is the provider's word
// ("unknown" while it runs), never tmux's "running".
const live = (row) => row.running === true && row.serverUnreached !== true
  && (row.runtimeState == null || row.runtimeState === 'running' || sessionProvider(row) !== null);

export function homeBoard(rows, { stale = () => false, pins = false } = {}) {
  const needsYou = [], running = [], counts = { agents: 0, running: 0, needYou: 0, stopped: 0, unknown: 0 };
  for (const row of rowsOf(rows)) {
    counts.agents++;
    const claim = waitingClaim(row, { stale: stale(row) === true });
    if (claim) needsYou.push({ row, claim });
    else if (live(row)) { counts.running++; running.push(row); }
    else if (row.running === false) counts.stopped++;
    else counts.unknown++;
  }
  needsYou.sort((a, b) => since(b.claim) - since(a.claim) || rosterOrder(a.row, b.row));
  counts.needYou = needsYou.length;
  return { needsYou, running: homeAgents(running, { pins }), counts };
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
