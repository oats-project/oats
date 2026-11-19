// bb.app: the OATS plugin's web UI. This file only registers slots; what each one draws is in
// app/, and what they draw from is in model/ (pure) and app/store.ts (the plugin's reads).
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadAction, PluginThreadActionItemInput } from "@get-bb/plugin-sdk/app";
import type { AgentState } from "./model/types";
import { ActsOverlay, askPlan, run } from "./app/acts";
import { HomePage, HomeTab, useHomeBadge } from "./app/Home";
import { IdentityRow } from "./app/IdentityRow";
import { CapabilitiesPage, MachinesPage, TeamsPage } from "./app/pages/Lists";
import { SoulsPage } from "./app/pages/Souls";
import { Sidebar } from "./app/Sidebar";
import { useOats } from "./app/oats";
import type { Oats } from "./app/oats";
import type { Contract, Rpc } from "./app/store";

/**
 * Icon names, each checked at runtime on bb-app 0.50.1: bb draws its generic glyph for a name its
 * set does not resolve, and says nothing (`Users`, `Monitor`, `Diamond`, `Hexagon`, `RotateCw`,
 * `CircleStop` do not resolve). Check a new name in the running app before using it.
 */
const ICON = {
  home: "Bot",
  souls: "Brain",
  capabilities: "Puzzle",
  teams: "Layers",
  machines: "Laptop",
  stop: "Square",
  start: "Play",
  restart: "RotateCcw",
  retire: "Trash2",
} as const;

type ActionData = { oats: Oats; rpc: Rpc };
const useActionData = (): ActionData => ({ oats: useOats(), rpc: useRpc<Contract>() });

/**
 * One lifecycle action in every thread menu, shown only on a thread that is an OATS agent and
 * only in the states it applies to. Each goes through OATS, so a stopped agent stays stopped.
 */
function lifecycle(
  id: string,
  order: number,
  label: string,
  icon: string,
  when: (state: AgentState) => boolean,
  act: (instance: string, input: PluginThreadActionItemInput<ActionData>) => void | Promise<void>,
  variant: PluginThreadAction["variant"] = "default",
) {
  return {
    id,
    title: label,
    icon,
    group: THREAD_ACTION_GROUPS.lifecycle,
    order,
    useData: useActionData,
    item: (input: PluginThreadActionItemInput<ActionData>): PluginThreadAction | null => {
      const { oats } = input.data;
      if (oats.phase !== "ready") return null;
      const node = oats.nodeByThread.get(input.thread.id);
      if (node === undefined || !when(node.state)) return null;
      return { label, icon, variant, run: () => act(node.agent.instance, input) };
    },
  };
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "agents",
    title: "OATS agents",
    description: "Your OATS agents as a tree, children under parents, then every other thread.",
    component: Sidebar,
  });
  app.slots.experimental_threadHeaderRow({ id: "identity", order: 0, component: IdentityRow });

  app.slots.navPanel({
    id: "home",
    title: "OATS",
    icon: ICON.home,
    path: "home",
    component: HomePage,
    experimental_useBadge: useHomeBadge,
  });
  app.slots.experimental_tab({
    id: "home",
    context: { kind: "thread" },
    availability: "fixed",
    title: "OATS",
    icon: ICON.home,
    layout: "flush",
    component: HomeTab,
  });

  // The four pages are opened from the "oats" block at the top of our thread list, and stay out
  // of bb's own navigation.
  app.slots.navPanel({ id: "souls", title: "Souls", icon: ICON.souls, path: "souls", experimental_hideFromNavigation: true, component: SoulsPage });
  app.slots.navPanel({ id: "capabilities", title: "Capabilities", icon: ICON.capabilities, path: "capabilities", experimental_hideFromNavigation: true, component: CapabilitiesPage });
  app.slots.navPanel({ id: "teams", title: "Teams", icon: ICON.teams, path: "teams", experimental_hideFromNavigation: true, component: TeamsPage });
  app.slots.navPanel({ id: "machines", title: "Machines", icon: ICON.machines, path: "machines", experimental_hideFromNavigation: true, component: MachinesPage });

  app.slots.experimental_threadAction(
    lifecycle("stop", 0, "Stop agent (OATS)", ICON.stop, (state) => state === "working" || state === "idle" || state === "needs-you", (instance) =>
      askPlan("stop", instance),
    ),
  );
  app.slots.experimental_threadAction(
    lifecycle("start", 1, "Start agent (OATS)", ICON.start, (state) => state === "stopped" || state === "error", (instance, { data, navigate }) =>
      run("start", instance, data.rpc, navigate),
    ),
  );
  app.slots.experimental_threadAction(
    lifecycle("restart", 2, "Restart agent (OATS)", ICON.restart, (state) => state !== "stopped", (instance, { data, navigate }) =>
      run("restart", instance, data.rpc, navigate),
    ),
  );
  app.slots.experimental_threadAction(
    lifecycle("retire", 3, "Retire agent (OATS)", ICON.retire, () => true, (instance) => askPlan("retire", instance), "destructive"),
  );

  // Draws the plan dialogs of Stop and Retire, wherever they were asked from.
  app.slots.experimental_appOverlay({ id: "acts", component: ActsOverlay });
});
