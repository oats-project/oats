// Split-control button state for the tab strip — pure derivation so the
// enabled/disabled gating is unit-testable and provably identical to the
// action gating in shell.mjs: buttons never encode their own policy, they
// dry-run the SAME model transition (requestSplit) the split.* actions use
// and merely render whether it would change anything.
import { requestSplit } from "./split-layout.mjs";

/** Derive the tab-strip split-control state.
 *   split      — the shell's current split model (or null)
 *   activeId   — the active tab id (or null)
 *   activeKind — the active tab's kind ("terminal", "file", …) or null
 *   tabLayerOn — whether the tab layer is the visible surface
 * Returns { visible, splitRow, splitCol } where splitRow/splitCol are
 * booleans: whether that control is enabled. The controls are
 * visible for a terminal OR a focused empty terminal group (never for
 * files/brains or the stage). Enablement mirrors the model:
 * a split request that would not change the model (an empty group already
 * waiting with the same orientation, MAX_SPLIT_GROUPS reached) renders
 * disabled. Closing a split has no button: split.close (its chord, the
 * palette) gates itself. */
export function splitControlsState(split, activeId, activeKind, tabLayerOn) {
  const emptyFocused = activeId == null && !!split?.groups.some(g =>
    g.id === split.focusedGroup && !g.tabs.length);
  // Slice 6a: every tab kind lives in the groups (a page beside a terminal), so any active tab can split.
  const visible = !!tabLayerOn && (activeId != null || emptyFocused);
  if (!visible) return { visible: false, splitRow: false, splitCol: false };
  const seed = [activeId]; // flat-state dry-run: any layer containing the active tab
  return {
    visible: true,
    splitRow: requestSplit(split, "row", seed, activeId).changed,
    splitCol: requestSplit(split, "col", seed, activeId).changed,
  };
}
