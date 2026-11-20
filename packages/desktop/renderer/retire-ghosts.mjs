/* oats desktop — the retired row's ghost (the Desktop UI rework, slice 4; guide v6 tour step 26: "After Enter, the
   row shows retiring…, then a dim ✕ ghost for 10 s").

   A retire this window confirmed and that answered complete is remembered by its row (`add`). Once the roster no
   longer lists that row, the roster draws a ghost of it in its place for GHOST_MS, then forgets it: a dim "✕ name"
   line, not a control, so the place where the agent was is visible for a moment and nothing can act on it. A ghost
   is drawn only in the workspace it was retired from, and never while the roster still lists its row (the
   Retiring… row is the roster's). Nothing here reads or decides a kernel fact: the ghost is only this window's
   memory of its own retire. */
import { instanceId } from "../../client/instance-tree.mjs";

export const GHOST_MS = 10_000;

/** What a ghost keeps of the row: its identity and its place in the tree (relation, deployment, birth). */
export function ghostOf(row) {
  const keep = ["instance", "agent", "agentsRoot", "home", "server", "parentInstance", "siblingInstance", "createdAt", "deployment", "background"];
  return { ...Object.fromEntries(keep.filter(key => row[key] !== undefined).map(key => [key, row[key]])), running: false, retiredGhost: true };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {() => void} [o.onExpire]  a ghost's time ran out: draw the roster again
 * @param {(fn: Function, ms: number) => unknown} [o.schedule]
 */
export function createRetireGhosts({ now = Date.now, onExpire = () => {}, schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const ghosts = new Map(); // instanceId -> { workspace, row, until }
  return {
    /** A retire of `row` in `workspace` answered complete. */
    add(row, workspace) { if (row) ghosts.set(instanceId(row), { workspace, row: ghostOf(row), until: null }); },
    /** The ghosts to draw beside `rows` (the roster as it lists `workspace` now). A ghost's 10 s start when its
     * row is first missing from the roster. */
    rows(rows, workspace) {
      const listed = new Set(rows.map(instanceId)), out = [];
      for (const [id, ghost] of ghosts) {
        if (ghost.workspace !== workspace || listed.has(id)) continue;
        if (ghost.until === null) { ghost.until = now() + GHOST_MS; const timer = schedule(onExpire, GHOST_MS + 50); timer?.unref?.(); }
        if (now() < ghost.until) out.push(ghost.row); else ghosts.delete(id);
      }
      return out;
    },
    clear() { ghosts.clear(); },
    size: () => ghosts.size,
  };
}
