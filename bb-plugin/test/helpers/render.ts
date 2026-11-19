// What every slot test needs: the plugin's registrations, the pinned fixtures as the app's RPC
// answers, and a clean app window between tests.
import { cleanup } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "../../contract";
import { resetActs } from "../../app/acts";
import { resetReads } from "../../app/store";
import type { Agent } from "../../model/types";
import { fixtureAgents, fixtureSnapshot, fixtureThreads } from "./fixtures";

export type Contract = typeof rpcContract;
export type Handlers = PluginRpcTestHandlers<Contract>;

export const loadApp = () => loadPluginApp(() => import("../../app"));

/** After each test: unmount, then forget the app window's shared reads and requests. */
export function resetApp(): void {
  cleanup();
  resetReads();
  resetActs();
}

export const SOULS = [
  {
    name: "oats-developer",
    agent: "oats-developer",
    description: "Builds and proves one spec.",
    origin: "oats.framework 1.12.0",
    capabilities: ["oats.core", "oats.aweb", "oats.developer"],
    spawnable: true,
    problem: null,
  },
  {
    name: "broken-soul",
    agent: "broken-soul",
    description: "",
    origin: "this repository",
    capabilities: [],
    spawnable: false,
    problem: "E_SOUL_INVALID: soul.yaml names a capability that is not installed: oats.missing",
  },
];

const unexpected = (method: string) => () => {
  throw new Error(`unexpected rpc ${method}`);
};

/** The fixtures as the server would answer them; a test overrides the methods it is about. */
export function handlers(over: Partial<Handlers> = {}, agents: Agent[] = fixtureAgents()): Handlers {
  return {
    snapshot: () => fixtureSnapshot(agents),
    souls: () => ({ souls: SOULS }),
    capabilities: () => ({
      capabilities: [{ id: "oats.core", description: "Day-to-day operation.", origin: "oats.framework 1.12.0", souls: 9 }],
    }),
    teams: () => ({ teams: [{ label: "oats", team: "default:oats.aweb.ai", isDefault: true }] }),
    machines: () => ({ machines: [{ id: "falcon", route: null, isThisMachine: true, note: null }] }),
    spawnPreview: unexpected("spawnPreview"),
    spawn: unexpected("spawn"),
    stopPlan: unexpected("stopPlan"),
    stopApply: unexpected("stopApply"),
    start: unexpected("start"),
    restart: unexpected("restart"),
    retirePlan: unexpected("retirePlan"),
    retireApply: unexpected("retireApply"),
    refresh: () => ({ at: "2026-11-19T12:31:00.000Z" }),
    ...over,
  };
}

export const sidebarThreads = () => ({ status: "ready" as const, threads: fixtureThreads() });
