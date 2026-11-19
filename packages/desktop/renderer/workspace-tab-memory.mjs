// Session-local UI memory, keyed by the resolved workspace (view) identity. Stores
// layout/selection and the focus place (focus-place.mjs) the workspace was left with: live tabs and
// terminal attachments remain shell-owned.
import { canActivateTab, fallbackTabForContext } from "./workspace-tabs.mjs";
import { removeSplitTab } from "./split-layout.mjs";

function copySplit(split) {
  return split ? { ...split, groups: split.groups.map(g => ({ ...g, tabs: [...g.tabs] })) } : null;
}

export function createWorkspaceTabMemory() {
  const states = new Map();
  return {
    remember(workspace, { split, activeTab, sidebarMode, tabLayerVisible, place = null }) {
      states.set(workspace, { split: copySplit(split), activeTab, sidebarMode, tabLayerVisible, place });
    },
    /** Views (#482, workspace-rehome.mjs): a memory under an id the map moves goes to its view,
     * unless that view already has its own (the newer one). */
    rehome(map) {
      for (const [from, saved] of [...states]) {
        const to = map.get(from);
        if (!to) continue;
        states.delete(from);
        if (!states.has(to)) states.set(to, saved);
      }
    },
    /** A workspace this window no longer has (another window took it over): its layout goes. */
    forget(workspace) { states.delete(workspace); },
    recall(workspace, entries) {
      const saved = states.get(workspace);
      if (!saved) return { split: null, activeTab: null, sidebarMode: "overview", tabLayerVisible: false };
      const tabs = new Map(entries);
      let split = copySplit(saved.split);
      // Closed/foreign tabs must not be resurrected by stale layout memory.
      for (const id of saved.split?.groups.flatMap(g => g.tabs) || []) {
        const tab = tabs.get(id);
        if (!canActivateTab(tab, workspace)) split = removeSplitTab(split, id).split; // any kind (slice 6a: pages too)
      }
      const focused = split?.groups.find(g => g.id === split.focusedGroup);
      const activeTab = canActivateTab(tabs.get(saved.activeTab), workspace) ? saved.activeTab
        : !saved.tabLayerVisible ? null
        : focused ? focused.activeTab
        : fallbackTabForContext(tabs, saved.sidebarMode, workspace)?.[0] ?? null;
      // An empty terminal layout is a real, restorable surface, not a missing
      // tab that should fall back to a different group or to the stage.
      return { ...saved, split, activeTab,
        tabLayerVisible: saved.tabLayerVisible && (activeTab != null || !!focused) };
    },
  };
}
