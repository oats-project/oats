// Session-local UI memory, keyed by the resolved workspace (view) identity. Stores
// layout/selection and the focus place (focus-place.mjs) the workspace was left with: live tabs and
// terminal attachments remain shell-owned.
import { canActivateTab, fallbackTabForContext } from "./workspace-tabs.mjs";
import { removeSplitTab } from "./split-layout.mjs";
import { sessionProvider } from "../../client/instance-presentation.mjs";

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
      // A terminal tab whose row (the one it last showed: `instanceRef`) runs on a session provider has no
      // terminal: it is never restored, in a group or as the active tab, and nothing is said of it. The shell
      // closes it on the next roster answer (retired-tabs.mjs, P).
      const restorable = tab => canActivateTab(tab, workspace) && !(tab.kind === "terminal" && sessionProvider(tab.instanceRef));
      // Closed/foreign tabs must not be resurrected by stale layout memory.
      for (const id of saved.split?.groups.flatMap(g => g.tabs) || []) {
        const tab = tabs.get(id);
        if (tab?.kind !== "terminal" || !restorable(tab)) split = removeSplitTab(split, id).split;
      }
      const focused = split?.groups.find(g => g.id === split.focusedGroup);
      const activeTab = restorable(tabs.get(saved.activeTab)) ? saved.activeTab
        : !saved.tabLayerVisible ? null
        : focused ? focused.activeTab
        : fallbackTabForContext([...tabs].filter(([, tab]) => restorable(tab)), saved.sidebarMode, workspace)?.[0] ?? null;
      // An empty terminal layout is a real, restorable surface, not a missing
      // tab that should fall back to a different group or to the stage.
      return { ...saved, split, activeTab,
        tabLayerVisible: saved.tabLayerVisible && (activeTab != null || !!focused) };
    },
  };
}
