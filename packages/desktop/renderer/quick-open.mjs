// oats desktop — Quick Open for souls (⌘P / Alt+P): a VS Code Quick Open-style
// overlay to find a SOUL and instantiate it. Data source is the Spawn
// view's roster (GET /api/agents); selecting a soul hands off to the Spawn
// view's own form flow (no second spawn form here — CLI degradation is the
// Spawn view's to render).
//
// Terminal policy (documented decision, #1217): app.quickOpenSouls is in the
// engine's TERMINAL_ALLOWLIST. On macOS ⌘P fires inside xterm by the ⌘-chord
// policy; on Linux/Windows its default is Alt+P, which xterm sends as ESC P
// (Esc, then P sends the same; Claude Code's own Alt+P, its model picker, is
// reached that way, docs/desktop-keyboard.md), and Ctrl+Alt+P in the Ctrl+Alt
// family, ESC Ctrl+P, so plain Ctrl+P (shell history) still reaches the pty.
import { createOverlayPicker } from "./overlay-picker.mjs";
import { subsequenceScore } from "../../client/subsequence-score.mjs";

/** Pure row computation — exported for tests. Attached-mode souls are shown
 * (they exist) but marked: selection still routes to the Spawn view, whose
 * card explains why they are not spawnable standalone. Each row carries its
 * catalog row (`soul`). `limit`: how many rows (12, Quick Open's list; the New
 * agent form's Soul field lists every match, `Infinity`). */
export function quickOpenRows(agents, query, { onPick, limit = 12 } = {}) {
  const q = String(query || "").trim();
  const rows = [];
  for (const a of agents) {
    const text = `${a.name} ${a.repoName || ""} ${a.description || ""}`;
    const sc = q ? subsequenceScore(text, q) : 0;
    if (sc == null) continue;
    const attached = a.work === "attached";
    rows.push({
      sc,
      label: a.name,
      detail: [a.repoName, attached ? "attached only" : "", a.description]
        .filter(Boolean).join(" · "),
      dot: null,
      soul: a,
      run: () => onPick({ name: a.name, agentsRoot: a.agentsRoot }),
    });
  }
  rows.sort((a, b) => a.sc - b.sc || String(a.label).localeCompare(String(b.label)));
  return rows.slice(0, limit);
}

/**
 * @param {object} deps
 * @param {() => Promise<{agents: Array}>} deps.loadSouls  the Spawn view's
 *        data source (GET /api/agents, workspace-scoped by the caller)
 * @param {(soul: {name: string, agentsRoot?: string}) => void} deps.onPick
 *        open the Spawn view with this soul's form preselected
 */
export function createQuickOpen({ loadSouls, onPick, doc }) {
  return createOverlayPicker({
    placeholder: "Find a soul…",
    ariaLabel: "Quick open souls",
    doc,
    loadItems: async () => { try { return await loadSouls(); } catch { return { agents: [] }; } },
    computeRows: (souls, raw) => quickOpenRows(souls?.agents || [], raw, { onPick }),
  });
}
