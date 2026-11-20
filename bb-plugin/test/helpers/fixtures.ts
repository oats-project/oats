// The pinned fixtures, as the app receives them: the kernel's status rows reduced to the plugin's
// `Agent` (the mapping `kernel/` does in the host entry), and bb's sidebar threads.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { parseStatus } from "../../kernel/status";
import type { Agent } from "../../model/types";

// vitest runs from the package root, under node and under jsdom alike.
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures", name), "utf8"));

/** The pinned status.json, read by the host entry's own parser into the plugin's `Agent` rows. */
export function fixtureAgents(): Agent[] {
  const status = parseStatus(read("status.json"));
  if (!status.ok) throw new Error(`status.json: ${status.error.code}: ${status.error.message}`);
  return status.value.agents;
}

/**
 * What bb-app 0.50.1 reports for the fields the pinned threads.json leaves out (recorded in the
 * backend probe's b2-frontend-useSidebarThreads.json): bb's thread menu reads them.
 */
const RECORDED_DEFAULTS = {
  titleFallback: null,
  parentNotifications: "off",
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  sectionId: null,
  originKind: null,
  originPluginId: null,
  isPinned: false,
  pinnedAt: null,
  pinSortKey: null,
  archivedAt: null,
  lastReadAt: null,
  latestAttentionAt: 0,
} satisfies Partial<PluginSidebarThread>;

export function fixtureThreads(): PluginSidebarThread[] {
  // testing/app 0.6.157 exports no sidebar-thread fixture, so the rows are the pinned recording
  // over the recorded defaults.
  const { threads } = read("threads.json") as { threads: Partial<PluginSidebarThread>[] };
  return threads.map((thread) => ({ ...RECORDED_DEFAULTS, ...thread }) as PluginSidebarThread);
}

export const DEPLOYMENT = { root: "/abs/deployment", workspace: "oats", machine: "falcon" };

export function fixtureSnapshot(agents: Agent[] = fixtureAgents()) {
  return { ok: true as const, at: "2026-11-19T12:30:00.000Z", deployment: DEPLOYMENT, agents };
}
