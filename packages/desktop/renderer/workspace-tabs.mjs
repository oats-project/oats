// Pure workspace scoping for every shell artifact. Same-named instances,
// souls and files may exist in several workspaces; a tab is only visible
// and eligible for activation in the workspace that opened it.
export function terminalTabsForWorkspace(entries, ws) {
  return [...entries].filter(([, tab]) => tab.kind === "terminal" && tab.workspace === ws);
}

/** Every tab of the workspace shows in its strip, whatever the sidebar's mode (the Desktop UI rework, slice 6a:
 * pages are tabs beside the terminals, brains and files, so no kind hides another). `mode` is kept for callers. */
export function tabVisibleInContext(tab, mode, ws) {
  return canActivateTab(tab, ws);
}

export function canActivateTab(tab, ws) {
  return !!tab && tab.workspace === ws;
}

export function fallbackTabForContext(entries, mode, ws) {
  return [...entries].filter(([, tab]) => tabVisibleInContext(tab, mode, ws)).at(-1) || null;
}

export function terminalOpenOwnsWorkspace(capturedWs, currentWs) {
  return capturedWs === currentWs;
}

/** Pick the terminal tab to activate for `ws`: the remembered per-workspace
 * active tab when it is still open IN THAT WORKSPACE, else the most recently
 * opened terminal of the workspace, else null. `rememberedKey` may be stale
 * (tab closed) or from another workspace — both fall back safely because the
 * candidate set is already workspace-filtered. */
export function restoreTerminalTab(entries, ws, rememberedKey) {
  const terms = terminalTabsForWorkspace(entries, ws);
  if (!terms.length) return null;
  return terms.find(([, tab]) => tab.key === rememberedKey) || terms.at(-1);
}
