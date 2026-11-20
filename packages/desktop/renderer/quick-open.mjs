// oats desktop — the souls' rows (quickOpenRows): find a SOUL by name, repository or description, to start an agent
// of it. Shared by the palette's souls group ("New agent: <soul>", palette.mjs; the Desktop UI rework, slice 4) and the
// New agent form's soul field (slice 5). Quick Open's own overlay (⌘P / Alt+P) folded into the palette: Alt+P opens
// the palette on its souls ("+"). The data source is the Spawn view's roster (GET /api/agents); picking a soul hands
// it to the caller's `onPick` (no second spawn form here: CLI degradation is the form's to render).
//
// Terminal policy (documented decision, #1217): app.quickOpenSouls is in the engine's TERMINAL_ALLOWLIST. On macOS
// ⌘P fires inside xterm by the ⌘-chord policy; on Linux/Windows its default is Alt+P, which xterm sends as ESC P
// (Esc, then P sends the same; Claude Code's own Alt+P, its model picker, is reached that way,
// docs/desktop-keyboard.md), and Ctrl+Alt+P in the Ctrl+Alt family, ESC Ctrl+P, so plain Ctrl+P (shell history)
// still reaches the pty.
import { subsequenceScore } from "../../client/subsequence-score.mjs";

/** Pure row computation — exported for tests. Attached-mode souls are shown
 * (they exist) but marked: selection still routes to the Spawn view, whose
 * card explains why they are not spawnable standalone. */
export function quickOpenRows(agents, query, { onPick } = {}) {
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
      run: () => onPick({ name: a.name, agentsRoot: a.agentsRoot }),
    });
  }
  rows.sort((a, b) => a.sc - b.sc || String(a.label).localeCompare(String(b.label)));
  return rows.slice(0, 12);
}
