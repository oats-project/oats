// A second picker of the overlay-picker family, for the tests of the family's handoff and accessibility: what
// renderer/quick-open.mjs createQuickOpen was before Quick Open folded into the palette (the Desktop UI rework,
// slice 4). It is test-only: the shipped app has one picker, the palette, and other pickers may come back.
import { createOverlayPicker } from "../../renderer/overlay-picker.mjs";
import { quickOpenRows } from "../../renderer/quick-open.mjs";

export function createSoulPicker({ loadSouls, onPick, doc }) {
  return createOverlayPicker({
    placeholder: "Find a soul…",
    ariaLabel: "Quick open souls",
    doc,
    loadItems: async () => { try { return await loadSouls(); } catch { return { agents: [] }; } },
    computeRows: (souls, raw) => quickOpenRows(souls?.agents || [], raw, { onPick }),
  });
}
