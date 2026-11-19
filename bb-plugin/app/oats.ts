// What every slot reads: the kernel's snapshot (through the plugin's server) joined to bb's own
// live thread list. bb's thread fields cost no `oats` call.
import { useMemo } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { isKernelCode } from "../kernel/result";
import type { Agent, Node, View } from "../model/types";
import { flatten, view } from "../model/view";
import { useRead } from "./store";

export type Deployment = { root: string; workspace: string; machine: string };

export type Oats = {
  /** bb's threads, as bb reports them; listed whatever OATS answers. */
  threads: readonly PluginSidebarThread[];
  threadById: ReadonlyMap<string, PluginSidebarThread>;
  retry(): void;
  /**
   * The soul to print for an agent: the key of the matching soul (`<package>/<soul>` for a
   * package soul) once the souls are read, else the roster's name for it.
   */
  soulOf(agent: Agent): string;
} & (
  | { phase: "loading" }
  /** No snapshot: `code` is the server's, or "E_PLUGIN_RPC" when the call itself failed. */
  | { phase: "failed"; code: string; message: string }
  | {
      phase: "ready";
      deployment: Deployment;
      agents: readonly Agent[];
      view: View;
      /** Every drawn node by its thread id, and by its instance. */
      nodeByThread: ReadonlyMap<string, Node>;
      nodeByInstance: ReadonlyMap<string, Node>;
    }
);

export function useOats(): Oats {
  const read = useRead("snapshot");
  // Only for the souls' names: the Souls page keeps this read fresh, a status change does not.
  const souls = useRead("souls", { live: false }).data?.souls;
  const sidebar = useSidebarThreads();
  const threads = sidebar.threads;
  const snapshot = read.status === "ready" ? read.data : undefined;

  const threadById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const joined = useMemo(() => {
    if (snapshot === undefined || !snapshot.ok) return null;
    const v = view(snapshot.agents, threads);
    const nodes = flatten(v.roots);
    return {
      view: v,
      nodeByThread: new Map(nodes.map((node) => [node.thread.id, node])),
      nodeByInstance: new Map(nodes.map((node) => [node.agent.instance, node])),
    };
  }, [snapshot, threads]);

  const soulNames = useMemo(() => new Map((souls ?? []).map((soul) => [soul.agent, soul.name])), [souls]);
  const soulOf = (agent: Agent) => soulNames.get(agent.soul) ?? agent.soul;
  const base = { threads, threadById, retry: read.retry, soulOf };
  if (read.status === "loading") return { ...base, phase: "loading" };
  if (read.status === "error") return { ...base, phase: "failed", code: "E_PLUGIN_RPC", message: read.error };
  if (!read.data.ok) return { ...base, phase: "failed", code: read.data.code, message: read.data.message };
  if (joined === null) return { ...base, phase: "loading" };
  return { ...base, phase: "ready", deployment: read.data.deployment, agents: read.data.agents, ...joined };
}

/** The first line of a message: what the sidebar's one status line has room for. */
export function firstLine(message: string): string {
  const line = message.split(/\r?\n/).find((part) => part.trim() !== "");
  return line === undefined ? message.trim() : line.trim();
}

/**
 * The one line a failed snapshot is shown as. A kernel refusal keeps the kernel's code before its
 * message; the plugin's own codes have messages that are whole sentences by themselves.
 */
export function failureLine(failure: { code: string; message: string }): string {
  const line = firstLine(failure.message);
  return isKernelCode(failure.code) ? `${failure.code}: ${line}` : line;
}
